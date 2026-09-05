import { isAddress, type Address } from "viem";
import { tempo as mainnet, tempoModerato } from "viem/chains";
import { Provider, Storage, Mount, tempoWallet } from "accounts";
import { Credential, type Challenge } from "mppx";
import { Mppx, tempo } from "mppx/client";
import { MAINNET_CURRENCY, PRO_CURRENCY } from "./pro-quote.js";

export type HostingOrder = {
  id: string; status: string; name: string; amount: string; amountAtomic: string; currency: string; token: string;
  network: string; chainId: number; quoteVersion: number; termDays: number; visibility: string; testMode: boolean;
  recipient: Address; hostingUntil?: string | null; transaction?: string; site?: { slug: string };
};
export function assertHostingOrder(order: HostingOrder) {
  const network = order.network === "tempo-testnet"
    ? order.chainId === 42431 && order.currency === "pathUSD" && order.token === PRO_CURRENCY && order.testMode === true
    : order.network === "tempo-mainnet" && order.chainId === 4217 && order.currency === "USDC.e" && order.token === MAINNET_CURRENCY && order.testMode === false;
  if (!network || !/^[a-f0-9]{48}$/.test(order.id) || order.quoteVersion !== 1 || order.visibility !== "private" ||
    order.amountAtomic !== "10000" || order.amount !== "0.01" || order.termDays !== 30 || !isAddress(order.recipient) || /^0x0{40}$/i.test(order.recipient)) throw Error("Payment terms changed. Refresh before paying.");
}
export async function assertHostingChallenge(order: HostingOrder, challenge: Challenge.Challenge) {
  assertHostingOrder(order);
  const q = challenge.request;
  const details = q.methodDetails as { chainId?: number; memo?: string; splits?: unknown; supportedModes?: string[] } | undefined;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(order.id));
  const memo = `0x${Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")}`;
  if (challenge.method !== "tempo" || challenge.intent !== "charge" || q.amount !== order.amountAtomic ||
    String(q.currency).toLowerCase() !== order.token || String(q.recipient).toLowerCase() !== order.recipient.toLowerCase() ||
    q.externalId !== order.id || details?.chainId !== order.chainId || details.memo !== memo || details.splits !== undefined ||
    (details.supportedModes !== undefined && !details.supportedModes.includes("pull"))) throw Error("Unexpected payment challenge. Nothing was signed.");
}
export function hostingWallet() {
  return Provider.create({ adapter: tempoWallet({ mount: Mount.popup() }), chains: [tempoModerato, mainnet],
    mpp: false, storage: Storage.memory(), persistCredentials: false });
}
export async function connectHostingPayer(wallet: ReturnType<typeof hostingWallet>, order: HostingOrder): Promise<Address> {
  assertHostingOrder(order);
  const result = await wallet.request({ method: "wallet_connect", params: [{ chainId: `0x${order.chainId.toString(16)}`,
    capabilities: { method: "login", selectAccount: true },
  }] });
  const account = result.accounts[0];
  if (!account || !isAddress(account.address) || account.capabilities.keyAuthorization) throw Error("Connect a personal wallet without granting an agent access key.");
  return account.address;
}
export async function payHostingOrder(order: HostingOrder, payer: Address, wallet: ReturnType<typeof hostingWallet>) {
  assertHostingOrder(order);
  const url = `/api/v1/private-payments/${order.id}/pay`;
  if (order.status === "paid" || order.status === "published") return fetch(url, { cache: "no-store" });
  const parameters = wallet.getMppxParameters();
  const client = Mppx.create({ polyfill: false, maxPaymentRetries: 1, methods: [tempo.charge({ ...parameters,
    account: payer, mode: "pull", autoSwap: false, expectedChainId: order.chainId, expectedRecipients: [order.recipient],
    getClient: async (options) => {
      const client = await parameters.getClient(options);
      if (client.account?.address.toLowerCase() !== payer.toLowerCase()) throw Error("The buyer wallet changed. Connect it again.");
      return client;
    },
  })] });
  const request = { cache: "no-store" as const };
  const challengeResponse = await client.rawFetch(url, request);
  if (challengeResponse.status !== 402) return challengeResponse;
  const prepared = await client.preparePayment(challengeResponse, { request });
  await assertHostingChallenge(order, prepared.challenge);
  const credential = await prepared.createCredential();
  const payload = Credential.deserialize(credential).payload;
  if (!payload || typeof payload !== "object" || !("type" in payload) || payload.type !== "transaction" ||
    !("signature" in payload) || typeof payload.signature !== "string" || !payload.signature.startsWith("0x76")) throw Error("Unsupported wallet proof. Check this order before retrying.");
  const { Transaction } = await import("viem/tempo");
  const transaction = Transaction.deserialize(payload.signature as `0x76${string}`);
  if (!transaction.validBefore || transaction.validBefore <= Math.floor(Date.now() / 1000) + 5) throw Error("Approval expired. Nothing was submitted. Approve this purchase again.");
  return client.rawFetch(url, prepared.setCredential(request, credential));
}
