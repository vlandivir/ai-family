export const assessmentStatuses = new Set(["fit", "conditional", "excluded", "reference"]);

export function interestingListing(row) {
  if (row?.status === "fit" || row?.status === "conditional") return true;
  // Older automatic cards stored the verdict as text while leaving status=new.
  if (row?.status !== "new") return false;
  return /^(?:fit|conditional|подходит|с оговорк(?:ой|ами))(?=$|\s|[—:;,.-])/i.test(String(row.fit || "").trim());
}
