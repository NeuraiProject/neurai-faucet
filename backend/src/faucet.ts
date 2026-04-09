import NeuraiKey from '@neuraiproject/neurai-key';
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
const FAUCET_AMOUNT = Number(process.env.FAUCET_AMOUNT || 100);

// Map network to library format
const libNetwork = NETWORK === 'mainnet' ? 'xna' : 'xna-test';

const rpc = getRPC('user', 'pass', RPC_URL);

/**
 * Derives the faucet address and private key from the mnemonic
 */
export const getFaucetWallet = () => {
  try {
    const hdKey = NeuraiKey.getHDKey(libNetwork as any, MNEMONIC);
    const coinType = NeuraiKey.getCoinType(libNetwork as any);
    const addressObj = NeuraiKey.getAddressByPath(libNetwork as any, hdKey, `m/44'/${coinType}'/0'/0/0`);
    return addressObj;
  } catch (error) {
    console.error('Error deriving faucet wallet:', error);
    throw new Error('Could not derive faucet wallet. Check your MNEMONIC.');
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
  const confirmedUtxos: any[] = (await rpc('getaddressutxos', [{ addresses: [fromAddress] }]) as any) || [];

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
  const inputs = [...availableConfirmed, ...availableMempool];

  if (inputs.length === 0) {
    throw new Error('Faucet has no funds (no UTXOs found, including mempool).');
  }

  // 2. Calculate total spendable balance
  let totalSats = 0n;
  for (const i of inputs) totalSats += BigInt(i.satoshis);

  const amountSats = BigInt(FAUCET_AMOUNT) * 100000000n;
  const feeSats = 1000000n;

  if (totalSats < amountSats + feeSats) {
    throw new Error('Faucet has insufficient funds for this request.');
  }

  const changeSats = totalSats - amountSats - feeSats;

  // 3. Create raw transaction
  const payments = [
    { address: toAddress, valueSats: amountSats }
  ];

  // Add change output back to the faucet address
  if (changeSats > 0n) {
    payments.push({ address: fromAddress, valueSats: changeSats });
  }

  const builtTx = createPaymentTransaction({
    inputs: inputs.map((i: any) => ({ txid: i.txid, vout: i.vout })),
    payments: payments.map(p => ({ address: p.address, valueSats: p.valueSats }))
  });

  // 4. Sign transaction
  const signedTxHex = Signer.sign(
    libNetwork as any,
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
    { [fromAddress]: wallet.WIF }
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
