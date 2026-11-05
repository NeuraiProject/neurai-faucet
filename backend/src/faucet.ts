import NeuraiKey, { type IAddressObject, type IPQAddressObject } from '@neuraiproject/neurai-key';
import { createPaymentTransaction, decodeAddress, encodeDestinationScript } from '@neuraiproject/neurai-create-transaction';
import Signer, { estimateTransactionVbytes } from '@neuraiproject/neurai-sign-transaction';
import { getRPC, assertRpcGenesis, MAINNET_GENESIS_HASH, TESTNET_GENESIS_HASH } from '@neuraiproject/neurai-rpc';
import { checkCode, createOutputs } from '@neuraiproject/neurai-silent-payments';
import dotenv from 'dotenv';

dotenv.config();

const MNEMONIC = process.env.MNEMONIC || '';
const NETWORK = (process.env.NETWORK || 'testnet') as 'mainnet' | 'testnet';
const RPC_URL = NETWORK === 'mainnet'
  ? (process.env.RPC_URL_MAINNET || '')
  : (process.env.RPC_URL_TESTNET || '');
const FAUCET_WALLET_TYPE = (process.env.FAUCET_WALLET_TYPE || 'ecdsa').toLowerCase();
const FAUCET_AMOUNT = Number(process.env.FAUCET_AMOUNT || 100);
const COINBASE_MATURITY = Number(process.env.COINBASE_MATURITY || 10);
// The node relays from 1,000 sat/vbyte; the fee is computed on the signed size.
const FEE_RATE_SAT_PER_VBYTE = BigInt(process.env.FEE_RATE_SAT_PER_VBYTE || 2000);

type ChainNetwork = 'mainnet' | 'testnet';
export type FaucetWalletType = 'legacy' | 'ecdsa' | 'pq';
type FaucetWallet = IAddressObject | IPQAddressObject;
type KeyNetwork = 'xna' | 'xna-test' | 'xna-legacy' | 'xna-legacy-test' | 'xna-pq' | 'xna-pq-test';

// neurai-key 5 labels: `xna[-test]` is strict ECDSA witness v3 (nq1r… / tnq1r…),
// `xna-legacy[-test]` Base58 P2PKH and `xna-pq[-test]` strict PQ witness v2 (pq1z… / tpq1z…).
const keyNetworks: Record<ChainNetwork, Record<FaucetWalletType, KeyNetwork>> = {
  mainnet: { legacy: 'xna-legacy', ecdsa: 'xna', pq: 'xna-pq' },
  testnet: { legacy: 'xna-legacy-test', ecdsa: 'xna-test', pq: 'xna-pq-test' }
};

/**
 * Destination families the faucet pays, as `decodeAddress` names them. Generic
 * AuthScript v1 addresses (contracts, nc1p… / tnc1p…) are not paid: their
 * spending conditions are a script, not a wallet key. On mainnet the strict PQ
 * and ECDSA families are not active yet, so only Legacy is paid there.
 */
const PAYABLE_TYPES: Record<ChainNetwork, ReadonlySet<string>> = {
  mainnet: new Set(['p2pkh']),
  testnet: new Set(['p2pkh', 'ecdsa', 'pq'])
};
const SILENT_PAYMENT_NETWORK = NETWORK === 'mainnet' ? 'main' : 'test';

export function getConfiguredWalletType(): FaucetWalletType {
  if (FAUCET_WALLET_TYPE === 'legacy' || FAUCET_WALLET_TYPE === 'ecdsa' || FAUCET_WALLET_TYPE === 'pq') {
    if (NETWORK === 'mainnet' && FAUCET_WALLET_TYPE !== 'legacy') {
      throw new Error(`FAUCET_WALLET_TYPE "${FAUCET_WALLET_TYPE}" is not active on mainnet yet. Use "legacy".`);
    }
    return FAUCET_WALLET_TYPE;
  }

  throw new Error(`Unsupported FAUCET_WALLET_TYPE "${FAUCET_WALLET_TYPE}". Use "legacy", "ecdsa" or "pq".`);
}

function getWalletNetwork(): KeyNetwork {
  return keyNetworks[NETWORK][getConfiguredWalletType()];
}

/** Silent payments need every input to be a strict ECDSA v3 output (NIP-047). */
export function canPaySilentPayments(): boolean {
  return NETWORK === 'testnet' && getConfiguredWalletType() === 'ecdsa';
}

/** Address kinds this faucet pays, for the page. */
export function acceptedDestinations(): string[] {
  if (NETWORK === 'mainnet') return ['Legacy (N…)'];
  return ['Legacy (t…)', 'ECDSA (tnq1r…)', 'Post-quantum (tpq1z…)', ...(canPaySilentPayments() ? ['Silent payment code (tnsp1…)'] : [])];
}

export type Destination = { kind: 'address'; address: string } | { kind: 'silent'; code: string };

/** A request was refused for a reason the user can act on; the message is shown as is. */
export class DestinationError extends Error {}

/**
 * Validates a destination and returns it in canonical form: Bech32m addresses
 * and payment codes are case-insensitive, so they are lower-cased (one rate
 * limit per destination, however it is typed).
 */
export function parseDestination(input: string): Destination {
  const text = input.trim();
  if (/^t?nsp1/i.test(text)) {
    if (!canPaySilentPayments()) {
      throw new DestinationError(NETWORK === 'mainnet'
        ? 'Silent payments are not active on mainnet yet.'
        : 'This faucet cannot pay silent payment codes: its wallet is not an ECDSA wallet.');
    }
    const code = text.toLowerCase();
    const checked = checkCode(code, SILENT_PAYMENT_NETWORK);
    if (!checked.valid) {
      throw new DestinationError(checked.reason === 'network'
        ? `This silent payment code is for another network. This faucet is running on ${NETWORK}.`
        : 'Invalid silent payment code.');
    }
    return { kind: 'silent', code };
  }

  let destination: ReturnType<typeof decodeAddress>;
  try {
    destination = decodeAddress(text);
  } catch {
    throw new DestinationError('Invalid Neurai address');
  }
  const chain: ChainNetwork = destination.network.endsWith('-test') ? 'testnet' : 'mainnet';
  if (chain !== NETWORK) {
    throw new DestinationError(`Address network mismatch. This faucet is running on ${NETWORK}.`);
  }
  if (destination.type === 'authscript') {
    throw new DestinationError('Contract addresses (AuthScript nc1p… / tnc1p…) are not supported. Use a wallet address.');
  }
  if (!PAYABLE_TYPES[NETWORK].has(destination.type)) {
    throw new DestinationError('Only Legacy addresses (N…) can be paid on mainnet for now.');
  }
  return { kind: 'address', address: destination.type === 'p2pkh' ? text : text.toLowerCase() };
}

/** The key the rate limit counts a destination under. */
export function destinationKey(destination: Destination): string {
  return destination.kind === 'silent' ? destination.code : destination.address;
}

// fetch() refuses URLs with credentials, so `user:pass@` travels as Basic auth.
// Public endpoints accept any credentials.
function rpcFromUrl(raw: string) {
  const url = new URL(raw);
  const username = decodeURIComponent(url.username) || 'user';
  const password = decodeURIComponent(url.password) || 'pass';
  url.username = '';
  url.password = '';
  return getRPC(username, password, url.toString());
}

const rpc = rpcFromUrl(RPC_URL);

// Block 0 of the chain the faucet pays on. EXPECTED_GENESIS overrides it for
// regtest or a private network.
const EXPECTED_GENESIS = (process.env.EXPECTED_GENESIS || (NETWORK === 'mainnet' ? MAINNET_GENESIS_HASH : TESTNET_GENESIS_HASH)).toLowerCase();
let chainChecked: Promise<void> | null = null;

/** Refuses an RPC node of another chain (e.g. the testnet before the 2026-11-05 reset). Checked once. */
function assertChain(): Promise<void> {
  chainChecked ??= assertRpcGenesis(rpc, EXPECTED_GENESIS).catch((error: unknown) => {
    chainChecked = null;
    throw new Error(`The RPC node is not on the expected ${NETWORK} chain (genesis ${EXPECTED_GENESIS}): ${error instanceof Error ? error.message : JSON.stringify(error)}`);
  });
  return chainChecked;
}

/**
 * Derives the faucet address and private key from the mnemonic
 */
export const getFaucetWallet = (): FaucetWallet => {
  try {
    const walletType = getConfiguredWalletType();
    const network = getWalletNetwork();
    if (walletType === 'pq') {
      return NeuraiKey.getPQAddress(network as 'xna-pq' | 'xna-pq-test', MNEMONIC, 0, 0);
    }
    return NeuraiKey.getAddressPair(network as 'xna' | 'xna-test' | 'xna-legacy' | 'xna-legacy-test', MNEMONIC, 0, 0).external;
  } catch (error) {
    console.error('Error deriving faucet wallet:', error);
    throw new Error('Could not derive faucet wallet. Check your MNEMONIC and FAUCET_WALLET_TYPE.');
  }
};

/** Private keys for the signer: a plain WIF for Legacy, the neurai-key object for the strict families. */
function getSignerKeyMap(wallet: FaucetWallet): Record<string, any> {
  return { [wallet.address]: getConfiguredWalletType() === 'legacy' ? (wallet as IAddressObject).WIF : wallet };
}

type Coin = { txid: string; vout: number; script: string; satoshis: bigint };

/**
 * Sends Neurai to a destination address or silent payment code
 */
export const sendFaucetFunds = async (destination: Destination) => {
  await assertChain();
  const wallet = getFaucetWallet();
  const fromAddress = wallet.address;

  console.log(`Faucet Wallet Address: ${fromAddress}`);

  // 1. Get confirmed UTXOs
  const allConfirmedUtxos: any[] = (await rpc('getaddressutxos', [{ addresses: [fromAddress] }]) as any) || [];

  // Filter out immature UTXOs (need COINBASE_MATURITY confirmations; a coin
  // mined in the tip block has one, as the node counts them)
  const currentHeight: number = (await rpc('getblockcount', []) as any) || 0;
  const confirmedUtxos = allConfirmedUtxos.filter(
    (u: any) => (currentHeight - u.height + 1) >= COINBASE_MATURITY
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
  const mempoolIncoming: Coin[] = [];
  // For mempool UTXOs, the script field is not returned by getaddressmempool.
  // We derive the locking script from the faucet address (it's always the change output).
  const faucetScript = Buffer.from(encodeDestinationScript(fromAddress)).toString('hex');

  for (const entry of mempoolEntries) {
    if (BigInt(entry.satoshis) < 0n) {
      spentInMempool.add(`${entry.prevtxid}:${entry.prevout}`);
    } else {
      mempoolIncoming.push({
        txid: entry.txid,
        vout: entry.index,
        script: entry.script || faucetScript,  // derive script if not provided
        satoshis: BigInt(entry.satoshis)
      });
    }
  }

  // Filter confirmed UTXOs — remove those already spent in mempool
  const availableConfirmed: Coin[] = confirmedUtxos.filter(
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

  // A silent payment address is derived from the transaction's inputs, so it
  // is recomputed for every coin selection. NIP-047 needs strict ECDSA v3
  // inputs and a version 2 transaction, which is what this faucet builds.
  const payeeAddress = (selectedInputs: Coin[]): string => {
    if (destination.kind === 'address') return destination.address;
    const privateKey = (wallet as IAddressObject).privateKey;
    const [output] = createOutputs(
      selectedInputs.map((i) => ({ txid: i.txid, vout: i.vout, privateKey, script: i.script })),
      [{ code: destination.code, amount: FAUCET_AMOUNT }],
      { network: SILENT_PAYMENT_NETWORK }
    );
    return output.address;
  };

  // Fee of the signed transaction: inputs are sized by their script (a PQ
  // spend is ~977 vbytes, an ECDSA v3 one 70, a Legacy one 148).
  const feeFor = (selectedInputs: Coin[], toAddress: string) =>
    BigInt(estimateTransactionVbytes(selectedInputs.map((i) => ({ script: i.script })), [toAddress, fromAddress])) * FEE_RATE_SAT_PER_VBYTE;

  // Coin selection: start with the smallest UTXO that looks sufficient and add
  // the largest unused one until the inputs pay the amount and the fee.
  const bySmallest = [...allAvailable].sort((a, b) => (a.satoshis < b.satoshis ? -1 : a.satoshis > b.satoshis ? 1 : 0));
  const byLargest = [...bySmallest].reverse();

  const roughFee = feeFor([allAvailable[0]], fromAddress);
  const candidate = bySmallest.find((u) => u.satoshis >= amountSats + roughFee);
  const inputs: Coin[] = candidate ? [candidate] : [byLargest[0]];

  let feeSats = 0n;
  let selectedSats = 0n;
  let toAddress = '';

  for (let attempt = 0; attempt < allAvailable.length; attempt++) {
    selectedSats = inputs.reduce((acc, u) => acc + u.satoshis, 0n);
    toAddress = payeeAddress(inputs);
    feeSats = feeFor(inputs, toAddress);

    if (selectedSats >= amountSats + feeSats) break;

    // Not enough — add the largest unused UTXO
    const used = new Set(inputs.map((u) => `${u.txid}:${u.vout}`));
    const next = byLargest.find((u) => !used.has(`${u.txid}:${u.vout}`));
    if (!next) break;
    inputs.push(next);
  }

  if (selectedSats < amountSats + feeSats) {
    throw new Error('Faucet has insufficient funds for this request.');
  }

  const changeSats = selectedSats - amountSats - feeSats;
  console.log(`Coin selection: ${inputs.length} inputs, fee=${feeSats} sat (${Number(feeSats)/1e8} XNA), change=${changeSats} sat`);

  // 3. Create final transaction with correct change
  const payments: { address: string; valueSats: bigint }[] = [
    { address: toAddress, valueSats: amountSats }
  ];
  if (changeSats > 0n) {
    payments.push({ address: fromAddress, valueSats: changeSats });
  }

  const builtTx = createPaymentTransaction({
    inputs: inputs.map((i) => ({ txid: i.txid, vout: i.vout })),
    payments
  });

  // 4. Sign transaction
  const signedTxHex = Signer.sign(
    getWalletNetwork(),
    builtTx.rawTx,
    inputs.map((i) => ({
      address: fromAddress,
      assetName: 'XNA', // Base currency
      txid: i.txid,
      outputIndex: i.vout,
      script: i.script,
      satoshis: Number(i.satoshis),
      value: Number(i.satoshis) / 100000000
    })),
    getSignerKeyMap(wallet),
    // The signer prints every signing step unless told not to.
    { debug: false }
  );

  // 5. Broadcast transaction
  const txid: any = await rpc('sendrawtransaction', [signedTxHex]);

  return { txid, paidAddress: toAddress };
};
/**
 * Gets the balance of the faucet address
 */
export const getFaucetBalance = async () => {
  await assertChain();
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
