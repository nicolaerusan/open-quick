import type { Address } from "viem";
import { assertHostingOrder, connectHostingPayer, hostingWallet, payHostingOrder, type HostingOrder } from "./pro-hosting-payment.js";

const form = document.querySelector<HTMLFormElement>("#project")!;
const name = document.querySelector<HTMLInputElement>("#name")!;
const upload = document.querySelector<HTMLInputElement>("#files")!;
const review = document.querySelector<HTMLButtonElement>("#review")!;
const message = document.querySelector<HTMLElement>("#error")!;
const purchases = document.querySelector<HTMLElement>("#purchases")!;
let files: { path: string; content: string }[] = [];
let key = crypto.randomUUID();
let busy = false;
let wallet: ReturnType<typeof hostingWallet> | undefined;
const payers = new Map<string, Address>();
let orders: HostingOrder[] = [];
const text = (tag: string, value: string, className?: string) => {
  const node = document.createElement(tag); node.textContent = value; if (className) node.className = className; return node;
};
function action(label: string, work: () => Promise<void>, primary = false) {
  const button = document.createElement("button"); button.textContent = label; button.disabled = busy;
  if (primary) button.className = "primary";
  button.onclick = () => void run(work);
  return button;
}
async function read(response: Response) {
  const body = await response.json();
  if (!response.ok) throw Error(response.status === 404 ? "Your Host session may have expired. Reopen OpenQuick Pro from Commons and reuse the same purchase." : body.error ?? "Request failed. Check this purchase before retrying.");
  return body;
}
function render() {
  purchases.replaceChildren();
  if (!orders.length) purchases.append(text("p", "Your saved purchase will appear here. No payment is taken until you approve it."));
  for (const order of orders) {
    const card = document.createElement("article"); card.className = "purchase";
    const heading = document.createElement("div"); heading.append(text("h3", order.name), text("span", order.status, "tag")); card.append(heading);
    card.append(text("p", `${order.termDays} days · ${order.amount} ${order.testMode ? "test " : ""}${order.currency} · ${order.network === "tempo-mainnet" ? "Tempo mainnet" : "Tempo testnet"}`));
    card.append(text("p", `Receiving address: ${order.recipient}`, "address"));
    const controls = document.createElement("div"); controls.className = "buttons"; card.append(controls);
    if (order.status === "needs_review") card.append(text("p", "Payment outcome needs review. Do not pay again. Keep this order ID for the operator."));
    else if (order.status === "published") {
      if (order.hostingUntil) card.append(text("p", `Hosted through ${new Date(order.hostingUntil).toLocaleString()}`));
      card.append(text("p", "Published. Open this project from Private publishing in Commons."));
    } else if (order.status === "paid") controls.append(action("Finish publishing", async () => { assertHostingOrder(order); await read(await fetch(`/api/v1/private-payments/${order.id}/pay`, { cache: "no-store" })); await load(); }, true));
    else if (order.status === "pending") {
      const payer = payers.get(order.id);
      if (!payer) controls.append(action("Choose payment wallet", async () => {
        assertHostingOrder(order); wallet ??= hostingWallet(); payers.set(order.id, await connectHostingPayer(wallet, order)); render();
      }, true));
      else {
        card.append(text("p", `Paying from: ${payer}`, "address"));
        controls.append(action(`Pay ${order.amount} ${order.testMode ? "test " : ""}${order.currency}`, async () => {
          await read(await payHostingOrder(order, payer, wallet!)); await load();
        }, true));
        if (order.testMode) controls.append(action("Add test funds", async () => {
          assertHostingOrder(order);
          const [{ createPublicClient, http }, { tempoModerato }, { Actions }] = await Promise.all([import("viem"), import("viem/chains"), import("viem/tempo")]);
          await Actions.faucet.fundSync(createPublicClient({ chain: tempoModerato, transport: http() }), { account: payer, timeout: 30_000 });
          message.textContent = "Free test funds added to your buyer wallet.";
        }));
        controls.append(action("Change wallet", async () => { payers.delete(order.id); render(); }));
      }
    }
    if (order.transaction) card.append(text("p", `Transaction: ${order.transaction}`, "address"));
    card.append(text("p", `Order: ${order.id}`, "address")); purchases.append(card);
  }
}
async function load() {
  const data = await read(await fetch("/api/v1/private-projects", { cache: "no-store" }));
  orders = data.purchases; render();
}
async function run(work: () => Promise<void>) {
  if (busy) return;
  busy = true; message.textContent = "";
  document.querySelectorAll<HTMLButtonElement>("button").forEach(button => button.disabled = true);
  try { await work(); }
  catch (failure) { message.textContent = failure instanceof Error ? failure.message : "Check this purchase before retrying."; await load().catch(() => {}); }
  finally {
    busy = false; document.querySelectorAll<HTMLButtonElement>("button").forEach(button => button.disabled = false);
    review.disabled = files.length === 0; render();
  }
}
function filesChanged() {
  key = crypto.randomUUID(); review.disabled = busy || !files.length;
  document.querySelector("#files-status")!.textContent = `${files.length} file(s) ready. ${files.map(file => file.path).join(", ")}`;
}
document.querySelector<HTMLButtonElement>("#sample")!.onclick = () => {
  name.value ||= "My private Pro wiki";
  files = [{ path: "index.html", content: btoa('<!doctype html><title>My private wiki</title><style>body{font:20px system-ui;padding:48px;max-width:760px;margin:auto}</style><h1>My private Pro wiki</h1><p>Hosted by OpenQuick. Available only to the owner and approved viewers.</p>') }];
  filesChanged();
};
name.oninput = () => { key = crypto.randomUUID(); };
upload.onchange = () => void run(async () => {
  const selected = Array.from(upload.files ?? []);
  files = []; filesChanged();
  if (!selected.length || selected.length > 50 || selected.reduce((total, file) => total + file.size, 0) > 1_000_000) throw Error("Choose up to 50 files totaling at most 1 MB.");
  files = await Promise.all(selected.map(async file => {
    const bytes = new Uint8Array(await file.arrayBuffer()); let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return { path: file.name, content: btoa(binary) };
  })); filesChanged();
});
form.onsubmit = event => {
  event.preventDefault(); void run(async () => {
    const order = await read(await fetch("/api/v1/private-projects", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": key },
      body: JSON.stringify({ name: name.value, files, viewers: [] }) }));
    assertHostingOrder(order); await load();
  });
};
document.querySelector<HTMLButtonElement>("#refresh")!.onclick = () => void run(load);
void load().catch(failure => { message.textContent = failure.message; });
