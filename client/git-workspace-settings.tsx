import { useCallback, useEffect, useMemo, useState } from "react";
import { Text, View, StyleSheet } from "react-native";
import {
  useSettings,
  type PluginSurfaceProps,
  type SettingsState,
} from "@getpaseo/plugin/client";
import {
  SettingsCard,
  SettingsInput,
  SettingsSection,
  SettingsSelect,
  SettingsAction,
} from "@getpaseo/plugin/client/ui";
import { gitWorkspaceSettings } from "../shared/git-settings";

type ReadySettings = Extract<
  SettingsState<typeof gitWorkspaceSettings.schema>,
  { status: "ready" }
>;

const AUTOSAVE_DELAY_MS = 600;

function SettingsEditor({
  settings,
  theme,
}: {
  settings: ReadySettings;
  theme: PluginSurfaceProps["theme"];
}) {
  const [draft, setDraft] = useState(() => settings.values);

  const changeGitlabUrl = useCallback(
    (gitlabUrl: string) => setDraft((current) => ({ ...current, gitlabUrl })),
    [],
  );

  const changeCloneDir = useCallback(
    (cloneDir: string) => setDraft((current) => ({ ...current, cloneDir })),
    [],
  );

  const changeGithubCloneProtocol = useCallback(
    (githubCloneProtocol: "ssh" | "https") => setDraft((current) => ({ ...current, githubCloneProtocol })),
    [],
  );

  const changeCloneProtocol = useCallback(
    (cloneProtocol: "ssh" | "https") => setDraft((current) => ({ ...current, cloneProtocol })),
    [],
  );

  const changeDefaultIsolation = useCallback(
    (defaultIsolation: "worktree" | "local") => setDraft((current) => ({ ...current, defaultIsolation })),
    [],
  );

  const dirty =
    draft.gitlabUrl !== settings.values.gitlabUrl ||
    draft.cloneDir !== settings.values.cloneDir ||
    draft.githubCloneProtocol !== settings.values.githubCloneProtocol ||
    draft.cloneProtocol !== settings.values.cloneProtocol ||
    draft.defaultIsolation !== settings.values.defaultIsolation;

  useEffect(() => {
    if (!dirty || settings.saving || settings.saveError) return;
    const timer = setTimeout(() => {
      void settings.save(draft, settings.revision);
    }, AUTOSAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [dirty, settings, draft]);

  const styles = useMemo(
    () =>
      StyleSheet.create({
        container: {
          padding: 16,
          gap: 16,
        },
        savingText: {
          fontSize: 12,
          color: theme.colors.accent,
          marginTop: 8,
        },
        errorText: {
          fontSize: 12,
          color: theme.colors.statusDanger,
          marginTop: 8,
        },
      }),
    [theme],
  );

  return (
    <View style={styles.container}>
      <SettingsSection title="GitLab">
        <SettingsCard>
          <SettingsInput
            label="GitLab URL"
            hint="Адрес сервера, например https://gitlab.com или частный домен"
            initialValue={draft.gitlabUrl}
            onChangeText={changeGitlabUrl}
            placeholder="https://gitlab.com"
            disabled={settings.saving}
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="Локальная папка и клонирование">
        <SettingsCard>
          <SettingsInput
            label="Папка репозиториев"
            hint="Папка для хранения репозиториев"
            initialValue={draft.cloneDir}
            onChangeText={changeCloneDir}
            placeholder="~/repos"
            disabled={settings.saving}
          />

          <SettingsSelect<"ssh" | "https">
            label="Протокол GitHub"
            value={draft.githubCloneProtocol}
            options={[
              { label: "HTTPS", value: "https" },
              { label: "SSH (git@...)", value: "ssh" },
            ]}
            onValueChange={changeGithubCloneProtocol}
            disabled={settings.saving}
          />

          <SettingsSelect<"ssh" | "https">
            label="Протокол GitLab"
            value={draft.cloneProtocol}
            options={[
              { label: "SSH (git@...)", value: "ssh" },
              { label: "HTTPS", value: "https" },
            ]}
            onValueChange={changeCloneProtocol}
            disabled={settings.saving}
          />

          <SettingsSelect<"worktree" | "local">
            label="Тип области"
            value={draft.defaultIsolation}
            options={[
              { label: "Worktree (рекомендуется)", value: "worktree" },
              { label: "Локальная папка", value: "local" },
            ]}
            onValueChange={changeDefaultIsolation}
            disabled={settings.saving}
          />
        </SettingsCard>
      </SettingsSection>

      {settings.saving ? (
        <Text style={styles.savingText}>Сохранение...</Text>
      ) : null}
      {settings.saveError ? (
        <Text style={styles.errorText}>Не удалось сохранить: {settings.saveError}</Text>
      ) : null}
    </View>
  );
}

export function GitWorkspaceSettings({ theme }: PluginSurfaceProps) {
  const settings = useSettings(gitWorkspaceSettings);

  const styles = useMemo(
    () =>
      StyleSheet.create({
        screen: {
          flex: 1,
          backgroundColor: theme.colors.surface0,
          padding: 16,
        },
        infoText: {
          color: theme.colors.foregroundMuted,
          fontSize: 14,
        },
        errorText: {
          color: theme.colors.statusDanger,
          fontSize: 14,
        },
      }),
    [theme],
  );

  if (settings.status === "loading") {
    return (
      <View style={styles.screen}>
        <Text style={styles.infoText}>Загрузка...</Text>
      </View>
    );
  }

  if (settings.status !== "ready") {
    return (
      <View style={styles.screen}>
        <Text style={styles.errorText}>Не удалось загрузить: {settings.error}</Text>
        <SettingsAction
          label="Повторить"
          actionLabel="Перезагрузить"
          onPress={settings.reload}
        />
      </View>
    );
  }

  return <SettingsEditor settings={settings} theme={theme} />;
}
