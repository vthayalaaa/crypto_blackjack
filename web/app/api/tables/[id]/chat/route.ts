import { listChat, postChat } from "../../../../../lib/server/chat";
import { jsonError } from "../../../../../lib/server/http";
import { limit } from "../../../../../lib/server/limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function tableId(id: string): string {
  if (!/^[A-Za-z0-9_-]{8,32}$/.test(id)) throw new Error("That table link is not valid.");
  return id;
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    limit(request, "chat-read", 60);
    const { id } = await context.params;
    const messages = await listChat(tableId(id));
    return Response.json({ messages });
  } catch (error) {
    const missing = error instanceof Error && error.message === "No table is using that id.";
    return jsonError(error, missing ? 404 : 400);
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    limit(request, "chat-send", 20);
    const { id } = await context.params;
    const body = await request.json() as { body?: unknown; wallet?: unknown };
    const message = await postChat(tableId(id), body.body, body.wallet);
    return Response.json({ message });
  } catch (error) {
    const missing = error instanceof Error && error.message === "No table is using that id.";
    return jsonError(error, missing ? 404 : 400);
  }
}
