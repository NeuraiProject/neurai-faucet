import NeuraiKey, { type IAddressObject, type IPQAddressObject } from '@neuraiproject/neurai-key';
import { createPaymentTransaction, encodeDestinationScript } from '@neuraiproject/neurai-create-transaction';
import Signer from '@neuraiproject/neurai-sign-transaction';
import { getRPC } from '@neuraiproject/neurai-rpc';
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

type ChainNetwork = 'mainnet' | 'testnet';
type FaucetWalletType = 'legacy' | 'pq';
type LegacyNetwork = 'xna' | 'xna-test';
type PQNetwork = 'xna-pq' | 'xna-pq-test';
type SignerNetwork = LegacyNetwork | PQNetwork;
type FaucetWallet = IAddressObject | IPQAddressObject;

const networkByType: Record<ChainNetwork, { legacy: LegacyNetwork; pq: PQNetwork }> = {
  mainnet: {
    legacy: 'xna',
    pq: 'xna-pq'
  },
  testnet: {
    legacy: 'xna-test',
    pq: 'xna-pq-test'
  }
};

function getConfiguredWalletType(): FaucetWalletType {
  if (FAUCET_WALLET_TYPE === 'legacy' || FAUCET_WALLET_TYPE === 'pq') {
    return FAUCET_WALLET_TYPE;
  }

  throw new Error(`Unsupported FAUCET_WALLET_TYPE "${FAUCET_WALLET_TYPE}". Use "legacy" or "pq".`);
}

function getWalletNetwork(): SignerNetwork {
  return networkByType[NETWORK][getConfiguredWalletType()];
}

function isPQWallet(wallet: FaucetWallet): wallet is IPQAddressObject {
  return 'seedKey' in wallet;
}

function getSignerKeyMap(wallet: FaucetWallet): Record<string, string | {
  seedKey: string;
  authType: 0x01;
  witnessScript: string;
}> {
  if (isPQWallet(wallet)) {
    return {
      [wallet.address]: {
        seedKey: wallet.seedKey,
        authType: wallet.authType,
        witnessScript: wallet.witnessScript
      }
    };
  }

  return { [wallet.address]: wallet.WIF };
}

const rpc = getRPC('user', 'pass', RPC_URL);

/**
 * Derives the faucet address and private key from the mnemonic
 */
export const getFaucetWallet = (): FaucetWallet => {
  try {
    const walletType = getConfiguredWalletType();

    if (walletType === 'pq') {
      return NeuraiKey.getPQAddress(getWalletNetwork() as PQNetwork, MNEMONIC, 0, 0);
    }

    const legacyNetwork = getWalletNetwork() as LegacyNetwork;
    return NeuraiKey.getAddressPair(legacyNetwork, MNEMONIC, 0, 0).external;
  } catch (error) {
    console.error('Error deriving faucet wallet:', error);
    throw new Error('Could not derive faucet wallet. Check your MNEMONIC and FAUCET_WALLET_TYPE.');
  }
};

/**
 * Sends Neurai to a destination address
 */
export const sendFaucetFunds = async (toAddress: string) => {
  const wallet = getFaucetWallet();
  const fromAddress = wallet.address;

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
  const mempoolIncoming: any[] = [];
  // For mempool UTXOs, the script field is not returned by getaddressmempool.
  // We derive the locking script from the faucet address (it's always the change output).
  const faucetScript = Buffer.from(encodeDestinationScript(fromAddress)).toString('hex');

  for (const entry of mempoolEntries) {
    if (entry.satoshis < 0) {
      spentInMempool.add(`${entry.prevtxid}:${entry.prevout}`);
    } else {
      mempoolIncoming.push({
        txid: entry.txid,
        vout: entry.index,
        script: entry.script || faucetScript,  // derive script if not provided
        satoshis: entry.satoshis
      });
    }
  }

  // Filter confirmed UTXOs — remove those already spent in mempool
  const availableConfirmed = confirmedUtxos.filter(
    (u: any) => !spentInMempool.has(`${u.txid}:${u.outputIndex}`)
  ).map((u: any) => ({
    txid: u.txid,
    vout: u.outputIndex,
    script: u.script,
    satoshis: u.satoshis
  }));

  // Filter mempool incoming — remove those already spent by a later mempool tx
  // (e.g. change from TX1 that was already consumed by TX2)
  const availableMempool = mempoolIncoming.filter(
    (u: any) => !spentInMempool.has(`${u.txid}:${u.vout}`)
  );

  // Combine confirmed + unspent mempool incoming
  const allAvailable = [...availableConfirmed, ...availableMempool];

  if (allAvailable.length === 0) {
    throw new Error('Faucet has no funds (no UTXOs found, including mempool).');
  }

  const FEE_RATE = 10000n; // sat per byte (×10 to account for unsigned vs signed tx size difference)
  const amountSats = BigInt(FAUCET_AMOUNT) * 100000000n;

  // Helper: build an unsigned test tx to measure real byte size
  const buildTestTx = (selectedInputs: any[], fee: bigint) => {
    const sel = selectedInputs.reduce((acc: bigint, u: any) => acc + BigInt(u.satoshis), 0n);
    const change = sel - amountSats - fee;
    const payments: { address: string; valueSats: bigint }[] = [{ address: toAddress, valueSats: amountSats }];
    if (change > 0n) payments.push({ address: fromAddress, valueSats: change });
    return createPaymentTransaction({
      inputs: selectedInputs.map((i: any) => ({ txid: i.txid, vout: i.vout })),
      payments
    });
  };

  // Coin selection: start with the smallest UTXO that looks sufficient,
  // build the actual tx, measure real size + 10% buffer, recalculate fee.
  // If still not enough, add the next largest UTXO and repeat.
  const bySmallest = [...allAvailable].sort((a: any, b: any) => Number(BigInt(a.satoshis) - BigInt(b.satoshis)));
  const byLargest  = [...allAvailable].sort((a: any, b: any) => Number(BigInt(b.satoshis) - BigInt(a.satoshis)));

  // Rough estimate to find a starting candidate
  const estFee = FEE_RATE * 300n; // ~300 bytes for 1-input tx, conservative
  const candidate = bySmallest.find((u: any) => BigInt(u.satoshis) >= amountSats + estFee);
  let inputs: any[] = candidate ? [candidate] : [byLargest[0]];

  let feeSats = 0n;
  let selectedSats = 0n;

  for (let attempt = 0; attempt < allAvailable.length; attempt++) {
    selectedSats = inputs.reduce((acc: bigint, u: any) => acc + BigInt(u.satoshis), 0n);

    // Build tx with fee=0 to measure real size (output count is the same)
    const testTx = buildTestTx(inputs, 0n);
    const realBytes = BigInt(testTx.rawTx.length / 2);
    const bytesWithBuffer = realBytes * 11n / 10n; // +10% buffer
    feeSats = bytesWithBuffer * FEE_RATE;

    if (selectedSats >= amountSats + feeSats) break;

    // Not enough — add the largest unused UTXO
    const used = new Set(inputs.map((u: any) => `${u.txid}:${u.vout}`));
    const next = byLargest.find((u: any) => !used.has(`${u.txid}:${u.vout}`));
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
    inputs: inputs.map((i: any) => ({ txid: i.txid, vout: i.vout })),
    payments
  });

  // 4. Sign transaction
  const signedTxHex = Signer.sign(
    getWalletNetwork(),
    builtTx.rawTx,
    inputs.map((i: any) => ({
      address: fromAddress,
      assetName: 'XNA', // Base currency
      txid: i.txid,
      outputIndex: i.vout,
      script: i.script,
      satoshis: i.satoshis,
      value: i.satoshis / 100000000
    })),
    getSignerKeyMap(wallet)
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
  console.log('Balance RPC Response:', balanceResponse);
  // Balance response is typically { balance: sats, received: sats }
  const balanceSats = BigInt(balanceResponse?.balance || 0);
  return Number(balanceSats) / 100000000;
};
