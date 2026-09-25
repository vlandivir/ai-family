function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is empty`);
  return value;
}

async function rest(path, { method = "GET", body, prefer } = {}) {
  const response = await fetch(`${required("SUPABASE_URL")}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: required("SUPABASE_SERVICE_ROLE_KEY"),
      authorization: `Bearer ${required("SUPABASE_SERVICE_ROLE_KEY")}`,
      "content-type": "application/json",
      prefer: prefer || "return=representation",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(text || response.statusText);
  return text ? JSON.parse(text) : null;
}

export function dbGet(path) {
  return rest(path);
}

export function dbInsert(table, row) {
  return rest(table, { method: "POST", body: row });
}

export function dbPatch(path, row) {
  return rest(path, { method: "PATCH", body: row });
}
