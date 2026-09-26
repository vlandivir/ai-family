import { serverAuth } from "./supabase";

export async function allowedUser() {
  const allowed = new Set((process.env.ALLOWED_EMAILS || "")
    .split(",").map((email) => email.trim().toLowerCase()).filter(Boolean));
  if (!allowed.size) return null;
  const supabase = await serverAuth();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user?.email || !user.email_confirmed_at) return null;
  const googleIdentity = user.identities?.some((identity) => identity.provider === "google");
  if (!googleIdentity || !allowed.has(user.email.toLowerCase())) return null;
  return user;
}
