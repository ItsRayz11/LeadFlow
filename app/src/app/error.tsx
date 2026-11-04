"use client";

export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="authwrap">
      <div className="authcard glass" role="alert">
        <h1 style={{ fontSize: 22 }}>Something went wrong</h1>
        <p className="sub">The page could not load. Nothing you entered was lost or changed. This is usually a brief connection problem.</p>
        <button className="btn" onClick={() => reset()}>Try again</button>
      </div>
    </div>
  );
}
