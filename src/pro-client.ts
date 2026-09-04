import { createWalletClient, custom, type EIP1193Provider, type Address } from "viem";
import { tempoModerato } from "viem/chains";
import { Mppx, tempo } from "mppx/client";

type Order = { status: string; recipient: Address; amount: string; network: string; contentHash: string; paymentUrl: string; url?: string; releaseUrl?: string; transaction?: string };
const id = document.querySelector<HTMLElement>("[data-order]")!.dataset.order!;
const button = document.querySelector<HTMLButtonElement>("#pay")!;
const refresh = document.querySelector<HTMLButtonElement>("#refresh")!;
const status = document.querySelector<HTMLElement>("#status")!;
const error = document.querySelector<HTMLElement>("#error")!;
let order: Order;
async function show() {
  const res = await fetch(`/api/v1/pro-payments/${id}`, { cache: "no-store" });
  const body = await res.json(); if (!res.ok) throw Error(body.error ?? "Payment intent unavailable");
  order = body;
  document.querySelector("#recipient")!.textContent = order.recipient;
  document.querySelector("#fingerprint")!.textContent = order.contentHash;
  document.querySelector("#payment-url")!.textContent = order.paymentUrl;
  status.textContent = order.status === "published" ? "Payment confirmed. Your release is published." : order.status === "needs_review" ? "Payment needs operator review. Do not pay again." : order.status === "paid" ? "Payment confirmed. Retry to finish publication without another charge." : "Ready to pay. Your wallet will ask you to approve the transfer.";
  button.disabled = !["pending", "paid"].includes(order.status); button.hidden = order.status === "published"; refresh.disabled = false;
  button.textContent = order.status === "paid" ? "Finish publication" : "Connect wallet & pay 0.01 pathUSD";
  if (order.releaseUrl) {
    const link = document.createElement("a"); link.href = order.releaseUrl; link.textContent = "Open published release →";
    const receipt = document.createElement("p"); receipt.textContent = `Transaction: ${order.transaction}`;
    document.querySelector("#result")!.replaceChildren(link, receipt);
  }
}
button.onclick = async () => {
  button.disabled = true; error.textContent = "";
  try {
    // Never let an unexpected server response quietly raise the user's price.
    if (order.amount !== "0.01" || order.network !== "tempo-testnet") throw Error("Payment terms changed. Reload before paying.");
    if (order.status === "paid") { const res = await fetch(order.paymentUrl); if (!res.ok) throw Error((await res.json()).error); await show(); return; }
    const provider = (window as unknown as { ethereum?: EIP1193Provider }).ethereum;
    if (!provider) throw Error("Open this page with a Tempo-compatible browser wallet, or ask your funded agent to pay the payment URL below.");
    const wallet = createWalletClient({ chain: tempoModerato, transport: custom(provider) });
    const [account] = await wallet.requestAddresses(); if (!account) throw Error("No wallet connected");
    await wallet.switchChain({ id: tempoModerato.id });
    const client = Mppx.create({ polyfill: false, methods: [tempo.charge({ account, expectedChainId: tempoModerato.id, expectedRecipients: [order.recipient], getClient: () => createWalletClient({ account, chain: tempoModerato, transport: custom(provider) }) })],
      onChallenge: async (challenge, { createCredential }) => {
        if (challenge.request.amount !== "10000" || String(challenge.request.currency).toLowerCase() !== "0x20c0000000000000000000000000000000000000") throw Error("Unexpected payment amount or token");
        return createCredential();
      },
    });
    const response = await client.fetch(order.paymentUrl);
    if (!response.ok) throw Error((await response.json()).error ?? "Payment did not complete. Check status before retrying.");
    await show();
  } catch (failure) { error.textContent = failure instanceof Error ? failure.message : "Payment unavailable"; await show().catch(() => {}); }
};
refresh.onclick = () => { error.textContent = ""; void show().catch((e) => { error.textContent = e.message; }); };
void show().catch((e) => { error.textContent = e.message; });
