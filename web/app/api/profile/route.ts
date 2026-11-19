import { jsonError } from "../../../lib/server/http";
import { limit } from "../../../lib/server/limit";
import { ensureProfile, updateProfile } from "../../../lib/server/profiles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    limit(request, "profile-read", 60);
    const url = new URL(request.url);
    const profile = await ensureProfile(url.searchParams.get("chain"), url.searchParams.get("address"));
    return Response.json({ profile });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: Request) {
  try {
    limit(request, "profile-save", 30);
    const body = await request.json() as { chain?: unknown; address?: unknown };
    const profile = await ensureProfile(body.chain, body.address);
    return Response.json({ profile });
  } catch (error) {
    return jsonError(error);
  }
}

export async function PATCH(request: Request) {
  try {
    limit(request, "profile-edit", 20);
    const body = await request.json() as {
      chain?: unknown;
      address?: unknown;
      username?: unknown;
      avatarUrl?: unknown;
    };
    const profile = await updateProfile(body.chain, body.address, body.username, body.avatarUrl);
    return Response.json({ profile });
  } catch (error) {
    return jsonError(error);
  }
}
