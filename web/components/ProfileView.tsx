"use client";

import { useEffect, useState, type FormEvent } from "react";
import type { PublicProfile } from "../lib/profile";

function letter(profile: PublicProfile): string {
  const name = profile.username.trim();
  if (name) return name.slice(0, 1).toUpperCase();
  const address = profile.address.startsWith("0x") ? profile.address.slice(2) : profile.address;
  return address.slice(0, 1).toUpperCase();
}

function hue(address: string): number {
  let hash = 0;
  for (const char of address) hash = (hash * 33 + char.charCodeAt(0)) >>> 0;
  return hash % 360;
}

export function ProfileView({ chain, address }: { chain: string; address: string }) {
  const [profile, setProfile] = useState<PublicProfile | null>(null);
  const [username, setUsername] = useState("");
  const [avatarUrl, setAvatarUrl] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [brokenPicture, setBrokenPicture] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({ chain, address });
    void fetch(`/api/profile?${params}`, { signal: controller.signal })
      .then(async (response) => {
        const body = await response.json() as { profile?: PublicProfile; error?: string };
        if (!response.ok) throw new Error(body.error || "The profile could not be opened.");
        if (!body.profile) throw new Error("The profile could not be opened.");
        setProfile(body.profile);
        setUsername(body.profile.username);
        setAvatarUrl(body.profile.avatarUrl);
        setBrokenPicture(false);
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted) return;
        setError(caught instanceof Error ? caught.message : "The profile could not be opened.");
      });
    return () => controller.abort();
  }, [chain, address]);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!profile) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/profile", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chain: profile.chain, address: profile.address, username, avatarUrl }),
      });
      const body = await response.json() as { profile?: PublicProfile; error?: string };
      if (!response.ok || !body.profile) throw new Error(body.error || "The profile could not be saved.");
      setProfile(body.profile);
      setUsername(body.profile.username);
      setAvatarUrl(body.profile.avatarUrl);
      setBrokenPicture(false);
      setNotice("Profile saved.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The profile could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  const home = "/";
  return (
    <>
      <header className="nav">
        <a className="brand" href={home}>
          <span className="mark">♠</span>
          <span>
            <strong>DeFi Casino</strong>
            <small>Blackjack</small>
          </span>
        </a>
        <nav className="nav-links" aria-label="Casino">
          <a href={home}>Play</a>
        </nav>
      </header>
      <main className="page">
        <p className="eyebrow">Profile</p>
        {error ? <p className="banner bad" role="alert">{error}</p> : null}
        {notice ? <p className="banner good">{notice}</p> : null}
        {profile ? (
          <section className="panel profile">
            <div className="profile-head">
              {profile.avatarUrl && !brokenPicture ? (
                <img
                  className="avatar"
                  src={profile.avatarUrl}
                  alt=""
                  onError={() => setBrokenPicture(true)}
                />
              ) : (
                <span className="avatar" style={{ background: `hsl(${hue(profile.address)} 42% 62%)` }}>{letter(profile)}</span>
              )}
              <div>
                <h1>{profile.username || "Player"}</h1>
                <p className="hint">{profile.address}</p>
              </div>
            </div>
            <dl>
              <div><dt>Games played</dt><dd>{profile.gamesPlayed}</dd></div>
              <div><dt>Wins</dt><dd>{profile.wins}</dd></div>
            </dl>
            <form onSubmit={(event) => void save(event)}>
              <label>
                Username
                <input value={username} maxLength={24} onChange={(event) => setUsername(event.target.value)} />
              </label>
              <label>
                Avatar image
                <input
                  value={avatarUrl}
                  placeholder="https://"
                  onChange={(event) => setAvatarUrl(event.target.value)}
                />
              </label>
              <button className="solid" type="submit" disabled={busy}>{busy ? "Saving…" : "Save profile"}</button>
            </form>
          </section>
        ) : error ? null : <p className="hint">Opening the profile…</p>}
      </main>
    </>
  );
}
