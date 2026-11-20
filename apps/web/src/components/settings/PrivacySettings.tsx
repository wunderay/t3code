import { useAtomValue } from "@effect/atom-react";
import { useState } from "react";
import type { PrivacyPreferences } from "@t3tools/contracts";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { useScopedSettings } from "./useScopedSettings";

const OPTIONS = [
  [
    "productAnalytics",
    "Product analytics",
    "Allow T3/PostHog to receive installation and feature-use metadata. Prompts and code are not part of these analytics.",
  ],
  [
    "diagnosticExports",
    "Diagnostic exports",
    "Allow configured services to receive traces, metrics and logs, which may contain paths and errors. Local diagnostic files stay available when this is off.",
  ],
  [
    "connect",
    "T3 Connect",
    "Allow Connect sign-in, remote tunnel activation and recovery. Provider sign-in and local coding remain available when this is off.",
  ],
  [
    "activityPublishing",
    "Activity sharing",
    "Allow project/thread titles, model and activity status to reach the Connect relay. Requires Connect and its publication preference.",
  ],
  [
    "externalIcons",
    "External icons",
    "Allow Google, website and registry CDN icon requests when links or providers are displayed.",
  ],
  [
    "remoteMedia",
    "Remote images and videos",
    "Allow displayed remote media to contact external websites automatically. Local screenshots and attachments remain available when this is off.",
  ],
  [
    "codexReporting",
    "Codex optional reporting",
    "Allow Codex's normal analytics, feedback and diagnostic export settings. Required model requests continue either way.",
  ],
  [
    "claudeReporting",
    "Claude optional reporting",
    "Allow Claude's normal telemetry, error reporting and feedback surveys. Required model requests continue either way.",
  ],
] as const satisfies ReadonlyArray<readonly [keyof PrivacyPreferences, string, string]>;

export function PrivacySettings() {
  const { environment, scope } = useSettingsScope();
  if (scope.kind !== "environment" || !environment) {
    return (
      <SettingsSection title="Privacy and data sharing" id="privacy">
        <p className="text-sm text-muted-foreground">
          Choose one environment to change its privacy settings.
        </p>
      </SettingsSection>
    );
  }
  return <PrivacyForm key={environment.environmentId} />;
}

function PrivacyForm() {
  const { environment } = useSettingsScope();
  const saved = useScopedSettings((settings) => settings.privacy);
  const [draft, setDraft] = useState<Partial<PrivacyPreferences>>({});
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const canEdit = useAtomValue(
    serverEnvironment.updateSettings.permissionAtom(environment?.environmentId ?? null),
  );
  const update = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: true });
  const values = { ...saved, ...draft };
  const changed = OPTIONS.some(([key]) => values[key] !== saved[key]);
  return (
    <SettingsSection title="Privacy and data sharing" id="privacy">
      <p className="text-sm text-muted-foreground">
        Optional third-party requests are off by default. Model prompts, code context and
        coding-service requests still go to the providers you use. Saved changes apply after
        quitting and reopening T3 Code.
      </p>
      {OPTIONS.map(([key, title, description]) => (
        <SettingsRow
          key={key}
          title={title}
          description={description}
          serverScoped
          settingKeys={["privacy"]}
          control={
            <Switch
              aria-label={title}
              checked={values[key]}
              disabled={!canEdit || saving}
              onCheckedChange={(checked) => {
                setDraft((previous) => ({ ...previous, [key]: checked }));
                setMessage(null);
              }}
            />
          }
        />
      ))}
      <div className="flex items-center gap-3">
        <Button
          size="sm"
          disabled={!canEdit || !changed || saving}
          onClick={async () => {
            if (!environment) return;
            setSaving(true);
            const result = await update({
              environmentId: environment.environmentId,
              input: { patch: { privacy: values } },
            });
            setSaving(false);
            if (result._tag === "Success") {
              setDraft({});
              setMessage("Saved. Quit T3 Code and reopen it from its shortcut to apply.");
            }
          }}
        >
          {saving ? "Saving…" : "Save privacy settings"}
        </Button>
        <span className="text-sm text-muted-foreground" role="status">
          {message}
        </span>
      </div>
    </SettingsSection>
  );
}
