import { formatUnits } from "viem";

export const PRO_CURRENCY = "0x20c0000000000000000000000000000000000000";
export const PRIVATE_HOSTING_TERM_MS = 30 * 24 * 60 * 60 * 1000;
export const PRO_AMOUNT = "0.01";
const DAY_MS = 24 * 60 * 60 * 1000;

/** Stored per order. New deployment defaults must never reprice an old quote. */
export type ProQuote = {
  version: 1; product: "public-release" | "private-hosting";
  amountAtomic: string; decimals: 6; currency: "pathUSD"; token: typeof PRO_CURRENCY;
  network: "tempo-testnet"; chainId: 42431; termDays: number;
};
export type QuoteDefaults = { amountAtomic?: string; termDays?: number };

// Orders written before quote versioning always promised these exact terms.
// Keep this literal independent of future pricing/term defaults.
export function legacyQuote(privateHosting: boolean): ProQuote {
  return { version: 1, product: privateHosting ? "private-hosting" : "public-release",
    amountAtomic: "10000", decimals: 6, currency: "pathUSD",
    token: "0x20c0000000000000000000000000000000000000", network: "tempo-testnet", chainId: 42431,
    termDays: privateHosting ? 30 : 0 };
}

export function validateQuote(value: unknown, privateHosting: boolean): ProQuote {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid stored quote");
  const q = value as ProQuote;
  if (Object.keys(q).sort().join(",") !== "amountAtomic,chainId,currency,decimals,network,product,termDays,token,version" ||
    q.version !== 1 || q.product !== (privateHosting ? "private-hosting" : "public-release") ||
    q.network !== "tempo-testnet" || q.chainId !== 42431 || q.currency !== "pathUSD" || q.decimals !== 6 || q.token !== PRO_CURRENCY ||
    typeof q.amountAtomic !== "string" || !/^[1-9][0-9]{0,8}$/.test(q.amountAtomic) || BigInt(q.amountAtomic) > 100_000_000n ||
    !Number.isInteger(q.termDays) || (privateHosting ? q.termDays < 1 || q.termDays > 365 : q.termDays !== 0)) {
    throw Error("Unsupported or invalid stored quote");
  }
  return { ...q };
}

export function newQuote(privateHosting: boolean, defaults?: QuoteDefaults): ProQuote {
  return validateQuote({ ...legacyQuote(privateHosting), amountAtomic: defaults?.amountAtomic ?? "10000",
    termDays: privateHosting ? defaults?.termDays ?? PRIVATE_HOSTING_TERM_MS / DAY_MS : 0,
  }, privateHosting);
}
export const quoteAmount = (quote: ProQuote) => formatUnits(BigInt(quote.amountAtomic), quote.decimals);
export const quoteTermMs = (quote: ProQuote) => quote.termDays * DAY_MS;
