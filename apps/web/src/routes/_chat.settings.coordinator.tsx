import { createFileRoute } from "@tanstack/react-router";
import { CoordinatorSettingsPanel } from "../components/settings/SettingsPanels";

export const Route = createFileRoute("/_chat/settings/coordinator")({
  component: CoordinatorSettingsPanel,
});
