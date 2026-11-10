import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import {
  useRpc,
  useSettings,
  type PluginSurfaceProps,
} from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { GitAuthCard } from "./git-auth-card";
import { gitWorkspaceSettings } from "../shared/git-settings";
import {
  ListReposRpc,
  TriggerSyncRpc,
  CreateWorkspaceRpc,
  type RepoItem,
  type AuthStatus,
} from "../shared/git-contracts";

function formatSyncTime(ts?: number): string {
  if (!ts || ts === 0) return "Не синхронизировано";
  const diffSec = Math.floor((Date.now() - ts) / 1000);
  if (diffSec < 10) return "Только что";
  if (diffSec < 60) return `${diffSec} сек. назад`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} мин. назад`;
  const diffHour = Math.floor(diffMin / 60);
  return `${diffHour} ч. назад`;
}

export function GitWorkspaceSurface({ theme, layout }: PluginSurfaceProps) {
  const toast = useToast();
  const settingsState = useSettings(gitWorkspaceSettings);
  const gitlabUrl =
    settingsState.status === "ready" ? settingsState.values.gitlabUrl : "https://gitlab.com";
  const cloneDir =
    settingsState.status === "ready" ? settingsState.values.cloneDir : "~/repos";
  const cloneProtocol =
    settingsState.status === "ready" ? settingsState.values.cloneProtocol : "ssh";
  const githubCloneProtocol =
    settingsState.status === "ready" ? settingsState.values.githubCloneProtocol : "https";
  const defaultIsolation =
    settingsState.status === "ready" ? settingsState.values.defaultIsolation : "worktree";

  const listRepos = useRpc(ListReposRpc);
  const triggerSync = useRpc(TriggerSyncRpc);
  const createWorkspace = useRpc(CreateWorkspaceRpc);

  const requestSequence = useRef(0);
  const loadedScope = useRef<string | null>(null);
  const [provider, setProvider] = useState<"all" | "github" | "gitlab">("all");
  const [search, setSearch] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [repos, setRepos] = useState<RepoItem[]>([]);
  const [syncErrors, setSyncErrors] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState<number | undefined>(undefined);
  const [actionLoadingId, setActionLoadingId] = useState<string | null>(null);
  const [authStatus, setAuthStatus] = useState<{
    github?: AuthStatus;
    gitlab?: AuthStatus;
  }>({});

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedQuery(search);
    }, 150);
    return () => clearTimeout(timer);
  }, [search]);

  // Load Repos and Auth status from cache
  const loadRepos = useCallback(
    async (forceRefresh = false) => {
      const request = ++requestSequence.current;
      if (forceRefresh) setLoading(true);
      try {
        const res = await listRepos({
          provider,
          query: debouncedQuery,
          gitlabUrl,
          cloneDir,
          forceRefresh,
        });
        if (request !== requestSequence.current) return;
        setRepos(res.repos);
        setSyncErrors(res.errors ?? []);
        setLastSyncedAt(res.lastSyncedAt);
        setIsSyncing(Boolean(res.isSyncing));
        if (res.auth) {
          setAuthStatus(res.auth);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        toast.error(`Не удалось загрузить: ${msg}`);
      } finally {
        if (request === requestSequence.current) setLoading(false);
      }
    },
    [listRepos, provider, debouncedQuery, gitlabUrl, cloneDir, toast],
  );

  useEffect(() => {
    const scope = `${gitlabUrl}|${cloneDir}`;
    const first = loadedScope.current !== scope;
    loadedScope.current = scope;
    void loadRepos(first);
  }, [loadRepos, gitlabUrl, cloneDir]);

  // Manual trigger sync
  const handleManualSync = async () => {
    setIsSyncing(true);
    try {
      const res = await triggerSync({ gitlabUrl, cloneDir });
      setLastSyncedAt(res.lastSyncedAt);
      if (res.auth) {
        setAuthStatus(res.auth);
      }
      setSyncErrors(res.errors);
      if (res.success) toast.show(`Синхронизировано: ${res.count} проектов`, { variant: "success" });
      else toast.error("Не все репозитории удалось загрузить. Подробности под подключениями.");
      await loadRepos();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Не удалось синхронизировать: ${msg}`);
    } finally {
      setIsSyncing(false);
    }
  };

  // Handle Clone & Create Workspace
  const handleCreateWorkspace = async (repo: RepoItem) => {
    setActionLoadingId(repo.id);

    try {
      const protocol = repo.provider === "github" ? githubCloneProtocol : cloneProtocol;
      const cloneUrl = protocol === "ssh" ? repo.sshUrl : repo.httpUrl;
      const res = await createWorkspace({
        provider: repo.provider,
        repoFullName: repo.fullName,
        cloneUrl,
        branch: repo.defaultBranch,
        isolation: defaultIsolation,
        gitlabUrl,
        cloneDir,
      });

      toast.show(`Область создана: ${res.title}`, { variant: "success" });

      setRepos((prev) =>
        prev.map((r) => (r.id === repo.id ? { ...r, isLocal: true, localPath: res.localPath } : r)),
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Не удалось создать: ${msg}`);
    } finally {
      setActionLoadingId(null);
    }
  };

  const styles = useMemo(
    () =>
      StyleSheet.create({
        container: {
          flex: 1,
          backgroundColor: theme.colors.surface0,
          padding: layout.compact ? 12 : 20,
          gap: 12,
        },
        headerRow: {
          flexDirection: layout.compact ? "column" : "row",
          gap: 8,
          justifyContent: "space-between",
          alignItems: "center",
        },
        title: {
          fontSize: layout.compact ? 18 : 20,
          fontWeight: "bold",
          color: theme.colors.foreground,
        },
        syncRow: {
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
        },
        syncInfo: {
          fontSize: 12,
          color: theme.colors.foregroundMuted,
        },
        syncButton: {
          paddingHorizontal: 8,
          paddingVertical: 4,
          borderRadius: 6,
          backgroundColor: theme.colors.surface2,
          flexDirection: "row",
          alignItems: "center",
          gap: 4,
        },
        syncButtonText: {
          fontSize: 12,
          color: theme.colors.foreground,
          fontWeight: "500",
        },
        authRow: {
          flexDirection: "row",
          flexWrap: "wrap",
          gap: 8,
          backgroundColor: theme.colors.surface1,
          paddingHorizontal: 12,
          paddingVertical: 8,
          borderRadius: 8,
          borderWidth: 1,
          borderColor: theme.colors.border,
        },
        authBadge: {
          flexDirection: "row",
          alignItems: "center",
          gap: 4,
        },
        authText: {
          fontSize: 12,
          color: theme.colors.foreground,
        },
        searchBox: {
          flexDirection: layout.compact ? "column" : "row",
          gap: 8,
          alignItems: "center",
        },
        searchInput: {
          flex: 1,
          backgroundColor: theme.colors.surface1,
          color: theme.colors.foreground,
          paddingHorizontal: 12,
          paddingVertical: layout.compact ? 8 : 10,
          borderRadius: 8,
          fontSize: 14,
          borderWidth: 1,
          borderColor: theme.colors.border,
        },
        filterTabs: {
          flexDirection: "row",
          flexWrap: "wrap",
          gap: 6,
        },
        filterTab: {
          paddingHorizontal: 12,
          paddingVertical: 6,
          borderRadius: 6,
          backgroundColor: theme.colors.surface1,
          borderWidth: 1,
          borderColor: theme.colors.border,
        },
        filterTabActive: {
          backgroundColor: theme.colors.accent,
          borderColor: theme.colors.accent,
        },
        filterTabText: {
          fontSize: 13,
          color: theme.colors.foregroundMuted,
        },
        filterTabTextActive: {
          color: theme.colors.accentForeground,
          fontWeight: "bold",
        },
        repoCard: {
          backgroundColor: theme.colors.surface1,
          borderRadius: 8,
          padding: 12,
          marginBottom: 8,
          borderWidth: 1,
          borderColor: theme.colors.border,
          gap: 6,
        },
        repoHeader: {
          flexDirection: "row",
          justifyContent: "space-between",
          alignItems: "center",
        },
        repoTitleRow: {
          flexDirection: "row",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 6,
          flex: 1,
        },
        providerTag: {
          paddingHorizontal: 6,
          paddingVertical: 2,
          borderRadius: 4,
          backgroundColor: theme.colors.surface2,
          fontSize: 11,
          fontWeight: "600",
          color: theme.colors.foregroundMuted,
        },
        repoName: {
          flexShrink: 1,
          fontSize: 14,
          fontWeight: "600",
          color: theme.colors.foreground,
        },
        repoDesc: {
          fontSize: 12,
          color: theme.colors.foregroundMuted,
          lineHeight: 16,
        },
        repoFooter: {
          flexDirection: "row",
          flexWrap: "wrap",
          gap: 8,
          justifyContent: "space-between",
          alignItems: "center",
          marginTop: 2,
        },
        localTag: {
          fontSize: 12,
          color: theme.colors.statusSuccess,
        },
        notLocalTag: {
          fontSize: 12,
          color: theme.colors.foregroundMuted,
        },
        actionButton: {
          backgroundColor: theme.colors.accent,
          paddingHorizontal: 12,
          paddingVertical: 5,
          borderRadius: 6,
          flexDirection: "row",
          alignItems: "center",
          gap: 4,
        },
        actionButtonText: {
          color: theme.colors.accentForeground,
          fontSize: 12,
          fontWeight: "600",
        },
        emptyText: {
          textAlign: "center",
          color: theme.colors.foregroundMuted,
          padding: 30,
          fontSize: 13,
        },
      }),
    [theme, layout.compact],
  );

  return (
    <View style={styles.container}>
      {/* Title & Sync status */}
      <View style={styles.headerRow}>
        <Text style={styles.title}>Git-репозитории</Text>
        <View style={styles.syncRow}>
          <Text style={styles.syncInfo}>
            {isSyncing ? "Синхронизация..." : formatSyncTime(lastSyncedAt)}
          </Text>
          <Pressable
            style={styles.syncButton}
            disabled={isSyncing}
            onPress={handleManualSync}
          >
            {isSyncing ? (
              <ActivityIndicator size="small" color={theme.colors.foreground} />
            ) : null}
            <Text style={styles.syncButtonText}>Синхронизировать</Text>
          </Pressable>
        </View>
      </View>

      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>Подключения к этому серверу Paseo</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
        <GitAuthCard provider="github" status={authStatus.github} gitlabUrl={gitlabUrl} theme={theme} onConnected={handleManualSync} />
        <GitAuthCard provider="gitlab" status={authStatus.gitlab} gitlabUrl={gitlabUrl} theme={theme} onConnected={handleManualSync} />
      </View>
      {syncErrors.map((message) => <Text key={message} selectable style={{ color: theme.colors.statusDanger, fontSize: 12 }}>{message}</Text>)}

      {/* Search and Filter */}
      <View style={styles.searchBox}>
        <TextInput
          style={styles.searchInput}
          placeholder="Поиск репозиториев..."
          value={search}
          onChangeText={setSearch}
          placeholderTextColor={theme.colors.foregroundMuted}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <View style={styles.filterTabs}>
          {(["all", "github", "gitlab"] as const).map((p) => (
            <Pressable
              key={p}
              onPress={() => setProvider(p)}
              style={[
                styles.filterTab,
                provider === p && styles.filterTabActive,
              ]}
            >
              <Text
                style={[
                  styles.filterTabText,
                  provider === p && styles.filterTabTextActive,
                ]}
              >
                {p === "all" ? "Все" : p === "github" ? "GitHub" : "GitLab"}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>Личные репозитории, организации и группы с доступом у подключенного аккаунта</Text>
      {/* Repo list */}
      <ScrollView style={{ flex: 1 }}>
        {loading && repos.length === 0 ? (
          <View style={{ padding: 30, alignItems: "center" }}>
            <ActivityIndicator color={theme.colors.accent} size="small" />
          </View>
        ) : repos.length === 0 ? (
          <Text style={styles.emptyText}>Репозитории не найдены</Text>
        ) : (
          repos.map((repo) => {
            const isProcessing = actionLoadingId === repo.id;
            return (
              <View key={repo.id} style={styles.repoCard}>
                <View style={styles.repoHeader}>
                  <View style={styles.repoTitleRow}>
                    <Text style={styles.providerTag}>
                      {repo.provider === "github" ? "GitHub" : "GitLab"}
                    </Text>
                    <Text style={styles.repoName}>{repo.fullName}</Text>
                    {repo.isPrivate && (
                      <Text style={[styles.providerTag, { color: theme.colors.foregroundMuted }]}>
                        Приватный
                      </Text>
                    )}
                  </View>
                </View>

                {repo.description ? (
                  <Text style={styles.repoDesc} numberOfLines={2}>
                    {repo.description}
                  </Text>
                ) : null}

                <View style={styles.repoFooter}>
                  <View>
                    {repo.isLocal ? (
                      <Text style={styles.localTag}>На сервере</Text>
                    ) : (
                      <Text style={styles.notLocalTag}>Не скачан</Text>
                    )}
                  </View>

                  <Pressable
                    style={styles.actionButton}
                    disabled={isProcessing}
                    onPress={() => handleCreateWorkspace(repo)}
                  >
                    {isProcessing ? (
                      <ActivityIndicator size="small" color={theme.colors.accentForeground} />
                    ) : null}
                    <Text style={styles.actionButtonText}>
                      {isProcessing
                        ? repo.isLocal
                          ? "Открытие..."
                          : "Клонирование..."
                        : repo.isLocal
                          ? "Открыть"
                          : "Клонировать и открыть"}
                    </Text>
                  </Pressable>
                </View>
              </View>
            );
          })
        )}
      </ScrollView>
    </View>
  );
}
