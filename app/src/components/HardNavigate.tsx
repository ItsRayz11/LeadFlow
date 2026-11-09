"use client";
import { useEffect } from "react";

/** Loads a path as a normal full page. Used when the pop-up slot catches a route that is not a lead (such as /leads/new). */
export function HardNavigate({ to }: { to: string }) {
  useEffect(() => { window.location.replace(to); }, [to]);
  return null;
}
