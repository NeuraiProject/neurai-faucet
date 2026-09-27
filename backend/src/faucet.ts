import NeuraiKey, {
  type IAddressObject,
  type IPQAddressObject,
  type IPQAuthScriptAddressObject
} from '@neuraiproject/neurai-key';
import {
  createPaymentTransaction,
  decodeAddress,
  encodeDestinationScript,
  type AddressDestination,
  type DestinationType
} from '@neuraiproject/neurai-create-transaction';
import Signer, {
  estimateInputVbytes,
  estimateOutputBytes,
  estimateVirtualSize,
  type IUTXO,
  type PrivateKeyInput
} from '@neuraiproject/neurai-sign-transaction';
import { assertRpcGenesis, getRPC, MAINNET_GENESIS_HASH, TESTNET_GENESIS_HASH } from '@neuraiproject/neurai-rpc';
import dotenv from 'dotenv';

dotenv.config();

const MNEMONIC = process.env.MNEMONIC || '';
const NETWORK = (process.env.NETWORK || 'testnet') as 'mainnet' | 'testnet';
const RPC_URL = NETWORK === 'mainnet'
  ? (process.env.RPC_URL_MAINNET || '')
  : (process.env.RPC_URL_TESTNET || '');
const FAUCET_WALLET_TYPE = (process.env.FAUCET_WALLET_TYPE || 'legacy').toLowerCase();
const FAUCET_AMOUNT = Number(process.env.FAUCET_AMOUNT || 100);
const COINBASE_MATURITY = Number(process.env.COINBASE_MATURITY || 10);
// The genesis block the RPC node must serve. The override only exists to run the faucet against a regtest node.
const GENESIS_HASH = process.env.RPC_GENESIS_HASH
  || (NETWORK === 'mainnet' ? MAINNET_GENESIS_HASH : TESTNET_GENESIS_HASH);

// Twice the node's default minimum relay fee (1000 sat/vB).
const FEE_RATE_SATS_PER_VBYTE = 2000n;
// The node's DUST_RELAY_TX_FEE.
const DUST_RELAY_FEE_SATS_PER_KVB = 3000n;

type ChainNetwork = 'mainnet' | 'testnet';

/**
 * The address types of neurai-key 5, as the faucet names them:
 * - legacy:     Base58 P2PKH (N… / t…)
 * - authscript: generic AuthScript witness v1 with an ML-DSA-44 key (nc1p… / tnc1p…)
 * - pq:         strict post-quantum witness v2 (pq1z… / tpq1z…)
 * - ecdsa:      strict ECDSA witness v3 (nq1r… / tnq1r…)
 */
export type AddressType = 'legacy' | 'authscript' | 'pq' | 'ecdsa';
type FaucetWallet = IAddressObject | IPQAddressObject | IPQAuthScriptAddressObject;

const ADDRESS_TYPES: readonly AddressType[] = ['legacy', 'authscript', 'pq', 'ecdsa'];

/**
 * neurai-key 5 network label of each address type. Beware the renames since
 * neurai-key 3: "xna" is now ECDSA witness v3 (Legacy moved to "xna-legacy"),
 * and "xna-pq" is now PQ witness v2, not the AuthScript v1 of "xna-authscript".
 */
const keyNetworks = {
  mainnet: { legacy: 'xna-legacy', authscript: 'xna-authscript', pq: 'xna-pq', ecdsa: 'xna' },
  testnet: { legacy: 'xna-legacy-test', authscript: 'xna-authscript-test', pq: 'xna-pq-test', ecdsa: 'xna-test' }
} as const;

/**
 * Address types whose spending rules are active on each chain (Neurai-DePIN
 * chainparams). An AuthScript output of a family that is not active yet is
 * anyone-can-spend, so the faucet neither keeps its funds in one nor pays to one.
 */
const activeAddressTypes: Record<ChainNetwork, readonly AddressType[]> = {
  mainnet: ['legacy'],
  testnet: ['legacy', 'authscript', 'pq', 'ecdsa']
};

const addressTypeInfo: Record<AddressType, { label: string; prefix: Record<ChainNetwork, string> }> = {
  legacy: { label: 'Legacy', prefix: { mainnet: 'N', testnet: 't' } },
  authscript: { label: 'AuthScript', prefix: { mainnet: 'nc1p', testnet: 'tnc1p' } },
  pq: { label: 'Post-quantum', prefix: { mainnet: 'pq1z', testnet: 'tpq1z' } },
  ecdsa: { label: 'ECDSA', prefix: { mainnet: 'nq1r', testnet: 'tnq1r' } }
};

const addressTypeOfDestination: Record<DestinationType, AddressType> = {
  p2pkh: 'legacy',
  authscript: 'authscript',
  pq: 'pq',
  ecdsa: 'ecdsa'
};

function getConfiguredWalletType(): AddressType {
  const walletType = ADDRESS_TYPES.find((type) => type === FAUCET_WALLET_TYPE);
  if (!walletType) {
    throw new Error(`Unsupported FAUCET_WALLET_TYPE "${FAUCET_WALLET_TYPE}". Use one of: ${ADDRESS_TYPES.join(', ')}.`);
  }
  if (!activeAddressTypes[NETWORK].includes(walletType)) {
    throw new Error(`FAUCET_WALLET_TYPE "${walletType}" is not active on ${NETWORK}. Use one of: ${activeAddressTypes[NETWORK].join(', ')}.`);
  }
  return walletType;
}

function getWalletNetwork() {
  return keyNetworks[NETWORK][getConfiguredWalletType()];
}

/** Key material for the signer: the WIF of a secp256k1 wallet, the seed and AuthScript template of a PQ one. */
function getSignerKey(wallet: FaucetWallet): PrivateKeyInput {
  if ('seedKey' in wallet) {
    return {
      seedKey: wallet.seedKey,
      authType: wallet.authType,
      witnessScript: wallet.witnessScript
    };
  }

  return wallet.WIF;
}

/**
 * Smallest change the node relays to `address` (policy.cpp GetDustThreshold):
 * the output plus the input that will spend it, at the dust relay fee. That is
 * 546 sats for P2PKH but 3060 for a PQ output, whose spend carries a ~1 kvB witness.
 */
function getDustThreshold(address: string): bigint {
  const vbytes = estimateOutputBytes(address) + estimateInputVbytes({ address });
  return BigInt(Math.ceil(vbytes)) * DUST_RELAY_FEE_SATS_PER_KVB / 1000n;
}

const nodeRpc = getRPC('user', 'pass', RPC_URL);
let chainVerified: Promise<void> | undefined;

/**
 * The RPC client, once the node has shown it serves this faucet's chain. Legacy
 * addresses look the same on the reset testnet and on the one before it, so an
 * endpoint left on the old chain would read balances and pay claims there
 * without a single error. A failed check is retried on the next call.
 */
const rpc = async (method: string, params: any[]) => {
  chainVerified ??= assertRpcGenesis(nodeRpc, GENESIS_HASH).catch((error) => {
    chainVerified = undefined;
    throw new Error(`The RPC node is not on the ${NETWORK} chain this faucet expects. ${error instanceof Error ? error.message : error}`);
  });
  await chainVerified;
  return nodeRpc(method, params);
};

/**
 * Derives the faucet address and private key from the mnemonic
 */
export const getFaucetWallet = (): FaucetWallet => {
  try {
    const walletType = getConfiguredWalletType();
    const networks = keyNetworks[NETWORK];

    if (walletType === 'pq') {
      return NeuraiKey.getPQAddress(networks.pq, MNEMONIC, 0, 0);
    }
    if (walletType === 'authscript') {
      return NeuraiKey.getPQAuthScriptAddress(networks.authscript, MNEMONIC, 0, 0);
    }

    // Legacy and ECDSA share the secp256k1 derivation; the label picks the path and encoding.
    return NeuraiKey.getAddressPair(networks[walletType], MNEMONIC, 0, 0).external;
  } catch (error) {
    console.error('Error deriving faucet wallet:', error);
    throw new Error('Could not derive faucet wallet. Check your MNEMONIC and FAUCET_WALLET_TYPE.');
  }
};

/** The address types this faucet pays to, for the frontend's hints. */
export const getAcceptedAddressTypes = () =>
  activeAddressTypes[NETWORK].map((type) => ({
    type,
    label: addressTypeInfo[type].label,
    prefix: addressTypeInfo[type].prefix[NETWORK]
  }));

export type DestinationCheck =
  | { ok: true; type: AddressType }
  | { ok: false; code: 'invalid_address' | 'address_network_mismatch' | 'address_type_not_accepted'; message: string };

/**
 * Whether the faucet can pay to `address`: an address of this chain, of a type
 * whose spending rules are active here, and one the node itself decodes. The
 * node refuses the strict families before their activation height, so the last
 * check also catches an RPC node that does not run those rules yet.
 */
export const checkDestination = async (address: string): Promise<DestinationCheck> => {
  let destination: AddressDestination;
  try {
    destination = decodeAddress(address);
  } catch {
    return { ok: false, code: 'invalid_address', message: 'Invalid Neurai address.' };
  }

  const chain: ChainNetwork = destination.network.endsWith('-test') ? 'testnet' : 'mainnet';
  if (chain !== NETWORK) {
    return { ok: false, code: 'address_network_mismatch', message: `Address network mismatch. This faucet is running on ${NETWORK}.` };
  }

  const type = addressTypeOfDestination[destination.type];
  const accepted = activeAddressTypes[NETWORK];
  if (!accepted.includes(type)) {
    const acceptedLabels = accepted.map((t) => addressTypeInfo[t].label).join(', ');
    return {
      ok: false,
      code: 'address_type_not_accepted',
      message: `${addressTypeInfo[type].label} addresses are not active on ${NETWORK} yet. This faucet pays to: ${acceptedLabels}.`
    };
  }

  const validation: any = await rpc('validateaddress', [address]);
  if (validation?.isvalid !== true) {
    return {
      ok: false,
      code: 'address_type_not_accepted',
      message: `The Neurai node does not accept ${addressTypeInfo[type].label} addresses yet.`
    };
  }

  return { ok: true, type };
};

type SpendableUtxo = {
  txid: string;
  vout: number;
  script: string;
  satoshis: bigint;
};

/**
 * Sends Neurai to a destination address
 */
export const sendFaucetFunds = async (toAddress: string) => {
  const wallet = getFaucetWallet();
  const fromAddress = wallet.address;
  const signerNetwork = getWalletNetwork();

  console.log(`Faucet Wallet Address: ${fromAddress}`);

  // 1. Get confirmed UTXOs
  const allConfirmedUtxos: any[] = (await rpc('getaddressutxos', [{ addresses: [fromAddress] }]) as any) || [];

  // Filter out immature coinbase UTXOs (need COINBASE_MATURITY confirmations)
  const currentHeight: number = (await rpc('getblockcount', []) as any) || 0;
  const confirmedUtxos = allConfirmedUtxos.filter(
    (u: any) => (currentHeight - u.height) >= COINBASE_MATURITY
  );
  console.log(`UTXOs: ${allConfirmedUtxos.length} total, ${confirmedUtxos.length} mature (height=${currentHeight}, maturity=${COINBASE_MATURITY})`);

  // 2. Get unconfirmed (mempool) deltas for the faucet address
  //    Mempool entries: positive satoshis = incoming UTXO, negative = spent UTXO
  let mempoolEntries: any[] = [];
  try {
    mempoolEntries = (await rpc('getaddressmempool', [{ addresses: [fromAddress] }]) as any) || [];
  } catch (e) {
    console.warn('getaddressmempool not available, ignoring mempool:', e);
  }

  // Build set of txid:vout spent in mempool (negative satoshis = spend)
  const spentInMempool = new Set<string>();
  const mempoolIncoming: SpendableUtxo[] = [];
  // For mempool UTXOs, the script field is not returned by getaddressmempool.
  // We derive the locking script from the faucet address (it's always the change output).
  const faucetScript = Buffer.from(encodeDestinationScript(fromAddress)).toString('hex');

  for (const entry of mempoolEntries) {
    // Amounts beyond 2^53 arrive as decimal strings (neurai-rpc keeps them lossless).
    const satoshis = BigInt(entry.satoshis);
    if (satoshis < 0n) {
      spentInMempool.add(`${entry.prevtxid}:${entry.prevout}`);
    } else {
      mempoolIncoming.push({
        txid: entry.txid,
        vout: entry.index,
        script: entry.script || faucetScript,  // derive script if not provided
        satoshis
      });
    }
  }

  // Filter confirmed UTXOs — remove those already spent in mempool
  const availableConfirmed: SpendableUtxo[] = confirmedUtxos.filter(
    (u: any) => !spentInMempool.has(`${u.txid}:${u.outputIndex}`)
  ).map((u: any) => ({
    txid: u.txid,
    vout: u.outputIndex,
    script: u.script,
    satoshis: BigInt(u.satoshis)
  }));

  // Filter mempool incoming — remove those already spent by a later mempool tx
  // (e.g. change from TX1 that was already consumed by TX2)
  const availableMempool = mempoolIncoming.filter(
    (u) => !spentInMempool.has(`${u.txid}:${u.vout}`)
  );

  // Combine confirmed + unspent mempool incoming
  const allAvailable = [...availableConfirmed, ...availableMempool];

  if (allAvailable.length === 0) {
    throw new Error('Faucet has no funds (no UTXOs found, including mempool).');
  }

  const amountSats = BigInt(FAUCET_AMOUNT) * 100000000n;
  const payment = { address: toAddress, valueSats: amountSats };

  const toSignerUtxo = (u: SpendableUtxo): IUTXO => ({
    address: fromAddress,
    assetName: 'XNA', // Base currency
    txid: u.txid,
    outputIndex: u.vout,
    script: u.script,
    satoshis: u.satoshis,
    value: Number(u.satoshis) / 100000000
  });

  const buildTx = (selectedInputs: SpendableUtxo[], changeSats: bigint | null) => createPaymentTransaction({
    inputs: selectedInputs.map((u) => ({ txid: u.txid, vout: u.vout })),
    payments: changeSats === null ? [payment] : [payment, { address: fromAddress, valueSats: changeSats }]
  });

  // Fee of the signed transaction, sized with the worst-case witness of each
  // input: a PQ input weighs ~977 vB against 148 for P2PKH, so the size of the
  // unsigned transaction says nothing about it. Output values do not change the
  // size, so a zero change output is enough to measure the version that has one.
  const feeFor = (selectedInputs: SpendableUtxo[], withChange: boolean) => {
    const vsize = estimateVirtualSize(signerNetwork, buildTx(selectedInputs, withChange ? 0n : null).rawTx, selectedInputs.map(toSignerUtxo));
    return BigInt(vsize) * FEE_RATE_SATS_PER_VBYTE;
  };
  const sumSats = (selectedInputs: SpendableUtxo[]) => selectedInputs.reduce((acc, u) => acc + u.satoshis, 0n);

  // Coin selection: start with the smallest UTXO that covers the payment and
  // the fee on its own; failing that, keep adding the largest unused UTXO.
  // Every input spends the faucet address, so any single one costs the same.
  const bySmallest = [...allAvailable].sort((a, b) => (a.satoshis < b.satoshis ? -1 : a.satoshis > b.satoshis ? 1 : 0));
  const byLargest = [...bySmallest].reverse();

  const singleInputFee = feeFor([bySmallest[0]], true);
  const candidate = bySmallest.find((u) => u.satoshis >= amountSats + singleInputFee);
  const inputs = candidate ? [candidate] : [byLargest[0]];

  while (sumSats(inputs) < amountSats + feeFor(inputs, false)) {
    const next = byLargest.find((u) => !inputs.includes(u));
    if (!next) {
      throw new Error('Faucet has insufficient funds for this request.');
    }
    inputs.push(next);
  }

  // 3. Create final transaction. Change below the dust threshold would get the
  //    transaction rejected, so it goes to the fee instead.
  const selectedSats = sumSats(inputs);
  const feeWithChange = feeFor(inputs, true);
  const changeSats = selectedSats - amountSats - feeWithChange;
  const keepChange = changeSats >= getDustThreshold(fromAddress);
  const feeSats = keepChange ? feeWithChange : selectedSats - amountSats;

  console.log(`Coin selection: ${inputs.length} inputs, fee=${feeSats} sat (${Number(feeSats)/1e8} XNA), change=${keepChange ? changeSats : 0n} sat`);

  const builtTx = buildTx(inputs, keepChange ? changeSats : null);

  // 4. Sign transaction
  const signedTxHex = Signer.sign(
    signerNetwork,
    builtTx.rawTx,
    inputs.map(toSignerUtxo),
    { [fromAddress]: getSignerKey(wallet) }
  );

  // 5. Broadcast transaction
  const txid: any = await rpc('sendrawtransaction', [signedTxHex]);

  return txid;
};
/**
 * Gets the balance of the faucet address
 */
export const getFaucetBalance = async () => {
  const wallet = getFaucetWallet();
  const address = wallet.address;

  const balanceResponse: any = await rpc('getaddressbalance', [{ addresses: [address] }]);
  // Balance response is typically { balance: sats, received: sats }
  const balance = balanceResponse?.balance;
  if (!((typeof balance === 'number' && Number.isInteger(balance) && balance >= 0)
    || (typeof balance === 'string' && /^\d+$/.test(balance)))) {
    throw new Error('getaddressbalance returned an invalid balance. Check the RPC endpoint and address index.');
  }
  const balanceXna = Number(BigInt(balance)) / 100000000;
  if (!Number.isFinite(balanceXna)) {
    throw new Error('getaddressbalance returned an out-of-range balance.');
  }
  return balanceXna;
};
