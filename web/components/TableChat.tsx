"use client";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { chatLine, type ChatLine } from "../lib/chat";

function remember(lines: ChatLine[], line: ChatLine | null): ChatLine[] {
  if (!line || lines.some((item) => item.id === line.id)) return lines;
  return [...lines, line];
}

export function TableChat({
  tableId,
  canSend,
  wallet,
  notice,
  supabaseUrl,
  supabaseKey,
}: {
  tableId: string;
  canSend: boolean;
  wallet: string;
  notice: string;
  supabaseUrl: string;
  supabaseKey: string;
}) {
  const [lines, setLines] = useState<ChatLine[]>([]);
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const log = useRef<HTMLDivElement>(null);
  const client = useRef<SupabaseClient | null>(null);

  useEffect(() => {
    const box = log.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [lines]);

  useEffect(() => {
    const controller = new AbortController();
    setLines([]);
    setError("");
    void fetch(`/api/tables/${tableId}/chat`, { signal: controller.signal })
      .then(async (response) => {
        const body = await response.json() as { messages?: ChatLine[]; error?: string };
        if (!response.ok) throw new Error(body.error || "The chat could not be opened.");
        if (!controller.signal.aborted) setLines(body.messages ?? []);
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted) return;
        setError(caught instanceof Error ? caught.message : "The chat could not be opened.");
      });
    return () => controller.abort();
  }, [tableId]);

  useEffect(() => {
    if (!supabaseUrl || !supabaseKey) return;
    const supabase = client.current ?? createClient(supabaseUrl, supabaseKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    client.current = supabase;
    const channel = supabase
      .channel(`table-chat:${tableId}`)
      .on("postgres_changes", {
        event: "INSERT",
        schema: "public",
        table: "chat_messages",
        filter: `table_id=eq.${tableId}`,
      }, (payload) => {
        const line = chatLine(payload.new);
        setLines((current) => remember(current, line));
      })
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [tableId, supabaseUrl, supabaseKey]);

  async function send(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/tables/${tableId}/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body: text, wallet }),
      });
      const payload = await response.json() as { message?: ChatLine; error?: string };
      if (!response.ok || !payload.message) throw new Error(payload.error || "The message could not be sent.");
      setLines((current) => remember(current, payload.message ?? null));
      setText("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The message could not be sent.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="chat" aria-label="Table chat">
      <h2>Table chat</h2>
      <div className="chat-log" ref={log}>
        <div className="chat-lines">
          {lines.length === 0 ? <p className="hint">No messages yet.</p> : lines.map((line) => (
            <p key={line.id} className="chat-line"><strong>{line.name}</strong> {line.body}</p>
          ))}
        </div>
      </div>
      {error ? <p className="hint warn">{error}</p> : null}
      {canSend ? (
        <form className="chat-form" onSubmit={(event) => void send(event)}>
          <input
            value={text}
            maxLength={200}
            placeholder="Message the table"
            aria-label="Message"
            onChange={(event) => setText(event.target.value)}
          />
          <button className="solid" type="submit" disabled={busy || !text.trim()}>{busy ? "…" : "Send"}</button>
        </form>
      ) : (
        <p className="hint">{notice}</p>
      )}
    </section>
  );
}
