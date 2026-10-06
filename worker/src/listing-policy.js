export const assessmentStatuses = new Set(["fit", "conditional", "excluded", "reference"]);

export function interestingListing(row) {
  if (row?.status === "fit" || row?.status === "conditional") return true;
  // Older automatic cards stored the verdict as text while leaving status=new.
  if (row?.status !== "new") return false;
  return /^(?:fit|conditional|подходит|с оговорк(?:ой|ами))(?=$|\s|[—:;,.-])/i.test(String(row.fit || "").trim());
}

export const scanBudgetEur = 240000;

// Only an explicit price rejection may be reconsidered; other refusals stay final.
export function priceRejected(row) {
  if (!['excluded', 'reference'].includes(row?.status)) return false;
  if (row.details?.exclusionReason) return row.details.exclusionReason === 'over_budget';
  return /^(?:Цена выше лимита|Цена выше бюджета|Выше бюджета|Превышение бюджета|over.?budget)(?:\b|[ :])/i.test(String(row.fit || '').trim());
}

export function catalogPriority(row) {
  if (row.details?.category === 'houses') return 4;
  if (row.status === 'fit' || (row.status === 'new' && /^подходит|^fit/i.test(row.fit || ''))) return 1;
  if (interestingListing(row)) return 2;
  if (priceRejected(row)) return 3;
  return null;
}
