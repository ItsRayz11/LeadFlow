"use client";
import { ActionForm, Submit } from "@/components/ActionForm";
import { finishSetupAction } from "@/app/setup/actions";

/** Shown to the signed-in owner when registration was interrupted before the workspace was created. */
export function FinishSetupForm() {
  return (
    <div className="authcard glass">
      <h1 style={{ fontSize: 24 }}>Finish setup</h1>
      <p className="sub">Your account exists, but the workspace was not created. Enter the setup token to finish.</p>
      <ActionForm action={finishSetupAction} className="panel">
        <label className="field"><span>Setup token</span><input type="password" name="token" required autoComplete="off" /></label>
        <Submit>Finish setup</Submit>
      </ActionForm>
    </div>
  );
}
