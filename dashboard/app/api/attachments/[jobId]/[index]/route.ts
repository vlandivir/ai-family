import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { allowedUser } from "@/lib/access";

export const dynamic = "force-dynamic";

type StoredArtifact = { status?: string; kind?: string; objectKey?: string; name?: string };

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ jobId: string; index: string }> },
) {
  if (!await allowedUser()) return new Response("Unauthorized", { status: 401 });
  const { jobId, index } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(jobId) || !/^(0|[1-9]\d*)$/.test(index)) {
    return new Response("Not found", { status: 404 });
  }
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!serviceKey || !supabaseUrl) return new Response("Storage unavailable", { status: 503 });
  const response = await fetch(
    `${supabaseUrl}/rest/v1/agent_jobs?id=eq.${jobId}&source=eq.telegram&select=artifacts&limit=1`,
    { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` }, cache: "no-store" },
  );
  if (!response.ok) return new Response("Storage unavailable", { status: 503 });
  const rows = await response.json() as { artifacts: StoredArtifact[] | null }[];
  const artifact = rows[0]?.artifacts?.[Number(index)];
  if (artifact?.status !== "stored" || !artifact.objectKey || artifact.kind === "location" ||
      !artifact.objectKey.startsWith(`telegram-inbox/${jobId}/`)) {
    return new Response("Not found", { status: 404 });
  }
  const { HETZNER_S3_ENDPOINT: endpoint, HETZNER_S3_ACCESS_KEY: accessKeyId,
    HETZNER_S3_SECRET_KEY: secretAccessKey, HETZNER_S3_BUCKET: bucket } = process.env;
  if (!endpoint || !accessKeyId || !secretAccessKey || !bucket) {
    return new Response("Storage unavailable", { status: 503 });
  }
  const client = new S3Client({ region: "fsn1", endpoint,
    credentials: { accessKeyId, secretAccessKey }, forcePathStyle: true });
  const url = await getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: artifact.objectKey }),
    { expiresIn: 60 });
  return new Response(null, { status: 302, headers: { Location: url, "Cache-Control": "private, no-store" } });
}
