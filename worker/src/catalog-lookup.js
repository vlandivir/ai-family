import { dbGet } from "./db.js";

const statuses = {
  new: "Новая",
  fit: "Подходит",
  conditional: "С оговоркой",
  excluded: "Исключена",
  reference: "Ориентир",
  error: "Ошибка обработки",
  test: "Тестовая",
};

export function catalogNumberFromMessage(text) {
  const value = String(text || "").trim();
  const match = value.match(/^(?:\/(?:card|object|карточк[ау]|объект)(?:@\w+)?\s+|(?:№|#)\s*|(?:покажи\s+)?(?:карточк[ау]|объект)\s*(?:№\s*)?)(\d{1,9})$/i);
  const number = Number(match?.[1]);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function cardText(row, project, showProject) {
  const price = row.asking_price_eur == null
    ? "не указана"
    : `${Number(row.asking_price_eur).toLocaleString("ru-RU")} €`;
  const source = row.source_url || row.source_urls?.find(Boolean);
  return [
    `Объект №${row.catalog_number}${showProject ? ` · ${project.name}` : ""}`,
    `Адрес: ${row.address || [row.neighborhood, row.municipality].filter(Boolean).join(", ") || "не указан"}`,
    `Статус: ${statuses[row.status] || row.status}`,
    `Цена: ${price}`,
    source ? `[Открыть объявление](${source})` : "Ссылка на объявление не указана",
  ].join("\n");
}

export async function lookupCatalogNumber(number, projectSlug, { get = dbGet } = {}) {
  if (!Number.isInteger(number) || number <= 0) throw new Error("Invalid catalog number");
  const projectPath = projectSlug
    ? `projects?slug=eq.${encodeURIComponent(projectSlug)}&select=id,name,slug&limit=1`
    : "projects?select=id,name,slug&order=name.asc";
  const projects = await get(projectPath);
  if (projectSlug && !projects.length) return "Проект не найден.";
  const matches = [];
  for (const project of projects) {
    const rows = await get(
      `listings?project_id=eq.${project.id}&catalog_number=eq.${number}&select=catalog_number,address,neighborhood,municipality,status,asking_price_eur,source_url,source_urls&limit=1`,
    );
    if (rows[0]) matches.push({ row: rows[0], project });
  }
  if (!matches.length) return `Объект №${number} не найден.`;
  return matches.map(({ row, project }) => cardText(row, project, matches.length > 1 || !projectSlug)).join("\n\n");
}
