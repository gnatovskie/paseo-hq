import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginPopoverProps, PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useEffect, useState, useCallback } from "react";
import { Pressable, Text, View, ScrollView } from "react-native";
import {
  workersListRpc,
  type WorkerInfo,
} from "../shared/contracts";

export function useWorkers(enabled = true) {
  const getWorkers = useRpc(workersListRpc);
  const [workers, setWorkers] = useState<WorkerInfo[]>([]);
  const [loading, setLoading] = useState(false);

  const reload = useCallback(async () => {
    try {
      setLoading(true);
      const res = await getWorkers({});
      setWorkers(res.workers ?? []);
    } catch {
      // Игнорируем сетевые сбои
    } finally {
      setLoading(false);
    }
  }, [getWorkers]);

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void reload();
    const timer = setInterval(() => {
      if (live) void reload();
    }, 3000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [enabled, reload]);

  return { workers, reload, loading };
}

export function gib(n: number | null): string {
  return n === null ? "—" : `${(n / 1073741824).toFixed(1)} ГиБ`;
}

export function duration(ms: number | null): string {
  if (ms === null || ms <= 0) return "0 мин";
  const m = Math.floor(ms / 60000);
  return m >= 60 ? `${Math.floor(m / 60)} ч ${m % 60} мин` : `${m} мин`;
}

export function when(ms: number | null): string {
  if (ms === null) return "нет данных";
  return new Date(ms).toLocaleString("ru-RU", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function WorkersMetricsBar({
  theme,
  openPopover,
  enabled,
}: {
  theme: PluginTheme;
  openPopover: (Component: React.ComponentType<PluginPopoverProps>) => void;
  enabled: boolean;
}) {
  const { workers } = useWorkers(enabled);
  if (!enabled) return null;

  const c = theme.colors;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Работники и команда"
      onPress={() => openPopover(WorkersUsagePopover)}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        paddingHorizontal: 10,
        paddingVertical: 7,
        borderRadius: 9,
        backgroundColor: c.surface2,
        borderWidth: 1,
        borderColor: c.border,
        opacity: pressed ? 0.75 : 1,
        gap: 6,
      })}
    >
      {/* Название виджета */}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexShrink: 0 }}>
        <Text style={{ fontSize: 13 }}>👥</Text>
        <Text style={{ color: c.foreground, fontSize: 12, fontWeight: "600" }}>Команда</Text>
      </View>

      {/* Список работников: горизонтальная прокрутка, когда не влезают */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={{ flexShrink: 1, minWidth: 0 }}
        contentContainerStyle={{
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          paddingLeft: 2,
        }}
      >
        {workers.map((w) => {
          const isOnline = w.stats.available;
          const statusDot = isOnline
            ? w.status === "active"
              ? "#10b981"
              : "#3b82f6"
            : "#94a3b8";
          const cpuVal = w.stats.cpu !== null ? `${w.stats.cpu.toFixed(0)}%` : null;

          return (
            <View
              key={w.id}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 4,
                flexShrink: 0,
                paddingHorizontal: 6,
                paddingVertical: 2,
                borderRadius: 5,
                backgroundColor: c.surface1,
                borderWidth: 1,
                borderColor: c.border,
              }}
            >
              <View
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: 3,
                  backgroundColor: statusDot,
                }}
              />
              <Text style={{ fontSize: 11 }}>{w.avatar}</Text>
              <Text style={{ color: c.foreground, fontSize: 11, fontWeight: "500" }}>{w.name}</Text>
              {isOnline && cpuVal ? (
                <Text style={{ color: c.foregroundMuted, fontSize: 10.5, fontVariant: ["tabular-nums"] }}>
                  {cpuVal}
                </Text>
              ) : !isOnline ? (
                <Text style={{ color: c.foregroundMuted, fontSize: 10 }}>офлайн</Text>
              ) : null}
            </View>
          );
        })}
      </ScrollView>
    </Pressable>
  );
}

export function WorkersUsagePopover({ theme, layout }: PluginPopoverProps) {
  const { workers } = useWorkers(true);
  const c = theme.colors;

  return (
    <View
      style={{
        padding: layout.compact ? 16 : 14,
        gap: 12,
        minWidth: 320,
        maxWidth: 420,
        backgroundColor: c.surface1,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text style={{ fontSize: 18 }}>👥</Text>
          <Text style={{ color: c.foreground, fontSize: 15, fontWeight: "700" }}>
            Работники студии
          </Text>
        </View>
      </View>

      <ScrollView style={{ maxHeight: 480 }} contentContainerStyle={{ gap: 10 }}>
        {workers.map((w) => {
          const isOnline = w.stats.available;
          const statusText = isOnline
            ? w.status === "active"
              ? "Агент в работе"
              : "В сети"
            : "Офлайн";
          const statusColor = isOnline
            ? w.status === "active"
              ? "#10b981"
              : "#3b82f6"
            : "#94a3b8";

          return (
            <View
              key={w.id}
              style={{
                borderRadius: 10,
                backgroundColor: c.surface2,
                borderWidth: 1,
                borderColor: c.border,
                padding: 12,
                gap: 8,
              }}
            >
              {/* Шапка карточки сотрудника */}
              <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                  <Text style={{ fontSize: 16 }}>{w.avatar}</Text>
                  <Text style={{ color: c.foreground, fontSize: 14, fontWeight: "700" }}>{w.name}</Text>
                  <Text style={{ color: c.foregroundMuted, fontSize: 11 }}>({w.role})</Text>
                </View>

                <View
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 5,
                    paddingHorizontal: 6,
                    paddingVertical: 2,
                    borderRadius: 4,
                    backgroundColor: `${statusColor}18`,
                  }}
                >
                  <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: statusColor }} />
                  <Text style={{ color: statusColor, fontSize: 11, fontWeight: "600" }}>{statusText}</Text>
                </View>
              </View>

              {/* Метрики или сообщение о статусе */}
              {isOnline ? (
                <View style={{ gap: 4 }}>
                  <Text style={{ color: c.foreground, fontSize: 12.5 }}>
                    CPU: {w.stats.cpu === null ? "сбор..." : `${w.stats.cpu.toFixed(1)}%`} из {w.stats.cpuLimit ?? "—"} ядер
                  </Text>
                  <Text style={{ color: c.foreground, fontSize: 12.5 }}>
                    Память: {gib(w.stats.memory)} / {gib(w.stats.memoryLimit)}
                  </Text>
                  <Text style={{ color: c.foreground, fontSize: 12.5 }}>
                    Процессы: {w.stats.processes ?? "—"} (контейнер {w.container})
                  </Text>

                  {/* Активность агентов Paseo */}
                  <View
                    style={{
                      marginTop: 4,
                      paddingTop: 6,
                      borderTopWidth: 1,
                      borderTopColor: c.border,
                      gap: 2,
                    }}
                  >
                    <Text style={{ color: c.foregroundMuted, fontSize: 11.5 }}>
                      Время работы агентов за 24 ч: {duration(w.activity.agentMs)}
                    </Text>
                    <Text style={{ color: c.foregroundMuted, fontSize: 11.5 }}>
                      Последний запрос: {when(w.activity.lastMessage)}
                    </Text>
                    <Text style={{ color: c.foregroundMuted, fontSize: 11.5 }}>
                      Вход по SSH: {when(w.activity.lastSsh)}
                    </Text>
                  </View>
                </View>
              ) : (
                <View style={{ paddingVertical: 4 }}>
                  <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
                    Контейнер {w.container} пока не запущен на сервере.
                  </Text>
                </View>
              )}
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}

export function WorkersSurface({ theme, layout }: PluginSurfaceProps) {
  const { workers, reload, loading } = useWorkers(true);
  const c = theme.colors;

  const onlineCount = workers.filter((w) => w.stats.available).length;

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: c.surface0 }}
      contentContainerStyle={{ padding: 20, gap: 16 }}
    >
      {/* Шапка страницы */}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: 12,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <View
            style={{
              width: 38,
              height: 38,
              borderRadius: 10,
              backgroundColor: "#10b98120",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Icon name="Users" size={20} color="#10b981" />
          </View>
          <View>
            <Text style={{ color: c.foreground, fontSize: 18, fontWeight: "700" }}>
              Работники и команда
            </Text>
            <Text style={{ color: c.foregroundMuted, fontSize: 12.5, marginTop: 1 }}>
              Мониторинг изолированных сред, cgroup-лимитов и активности в Paseo ({onlineCount} из {workers.length} в сети)
            </Text>
          </View>
        </View>

        <Pressable
          accessibilityRole="button"
          onPress={() => void reload()}
          style={({ pressed }) => ({
            flexDirection: "row",
            alignItems: "center",
            gap: 6,
            paddingHorizontal: 12,
            paddingVertical: 7,
            borderRadius: 8,
            backgroundColor: c.surface2,
            borderWidth: 1,
            borderColor: c.border,
            opacity: pressed || loading ? 0.7 : 1,
          })}
        >
          <Icon name="RefreshCw" size={14} color={c.foreground} />
          <Text style={{ color: c.foreground, fontSize: 13, fontWeight: "500" }}>Обновить</Text>
        </Pressable>
      </View>

      {/* Список работников в виде больших карточек */}
      <View
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          gap: 16,
        }}
      >
        {workers.map((w) => {
          const isOnline = w.stats.available;
          const statusText = isOnline
            ? w.status === "active"
              ? "Агент в работе"
              : "В сети (свободен)"
            : "Офлайн";
          const statusColor = isOnline
            ? w.status === "active"
              ? "#10b981"
              : "#3b82f6"
            : "#94a3b8";

          const cpuPercent = w.stats.cpu ?? 0;
          const memUsed = w.stats.memory ?? 0;
          const memLimit = w.stats.memoryLimit ?? 1;
          const memPercent = memLimit > 0 ? Math.min(100, (memUsed / memLimit) * 100) : 0;

          return (
            <View
              key={w.id}
              style={{
                width: layout.compact ? "100%" : "48.5%",
                minWidth: 320,
                backgroundColor: c.surface1,
                borderRadius: 12,
                borderWidth: 1,
                borderColor: c.border,
                padding: 18,
                gap: 14,
              }}
            >
              {/* Верхняя строка карточки: Аватар, Имя, Роль, Статус */}
              <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
                  <View
                    style={{
                      width: 44,
                      height: 44,
                      borderRadius: 12,
                      backgroundColor: c.surface2,
                      alignItems: "center",
                      justifyContent: "center",
                      borderWidth: 1,
                      borderColor: c.border,
                    }}
                  >
                    <Text style={{ fontSize: 24 }}>{w.avatar}</Text>
                  </View>
                  <View>
                    <Text style={{ color: c.foreground, fontSize: 16, fontWeight: "700" }}>
                      {w.name}
                    </Text>
                    <Text style={{ color: c.foregroundMuted, fontSize: 12, marginTop: 1 }}>
                      {w.role} • {w.container}
                    </Text>
                  </View>
                </View>

                <View
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 6,
                    paddingHorizontal: 8,
                    paddingVertical: 3,
                    borderRadius: 6,
                    backgroundColor: `${statusColor}18`,
                  }}
                >
                  <View style={{ width: 7, height: 7, borderRadius: 3.5, backgroundColor: statusColor }} />
                  <Text style={{ color: statusColor, fontSize: 11.5, fontWeight: "600" }}>
                    {statusText}
                  </Text>
                </View>
              </View>

              {/* Тело карточки: Системные ресурсы */}
              {isOnline ? (
                <View style={{ gap: 12 }}>
                  {/* Шкала CPU */}
                  <View style={{ gap: 4 }}>
                    <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                      <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>Загрузка CPU</Text>
                      <Text style={{ color: c.foreground, fontSize: 12, fontWeight: "600" }}>
                        {w.stats.cpu !== null ? `${w.stats.cpu.toFixed(1)}%` : "0%"} (лимит: {w.stats.cpuLimit ?? "—"} ядер)
                      </Text>
                    </View>
                    <View
                      style={{
                        height: 7,
                        borderRadius: 3.5,
                        backgroundColor: c.surface2,
                        overflow: "hidden",
                      }}
                    >
                      <View
                        style={{
                          height: "100%",
                          width: `${Math.min(100, Math.max(0, cpuPercent))}%`,
                          backgroundColor: cpuPercent >= 80 ? c.statusWarning : "#3b82f6",
                        }}
                      />
                    </View>
                  </View>

                  {/* Шкала памяти */}
                  <View style={{ gap: 4 }}>
                    <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                      <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>Оперативная память</Text>
                      <Text style={{ color: c.foreground, fontSize: 12, fontWeight: "600" }}>
                        {gib(w.stats.memory)} / {gib(w.stats.memoryLimit)}
                      </Text>
                    </View>
                    <View
                      style={{
                        height: 7,
                        borderRadius: 3.5,
                        backgroundColor: c.surface2,
                        overflow: "hidden",
                      }}
                    >
                      <View
                        style={{
                          height: "100%",
                          width: `${memPercent}%`,
                          backgroundColor: memPercent >= 85 ? c.statusWarning : "#10b981",
                        }}
                      />
                    </View>
                  </View>

                  {/* Сводка процессов и активности Paseo */}
                  <View
                    style={{
                      backgroundColor: c.surface2,
                      borderRadius: 9,
                      padding: 12,
                      gap: 6,
                      borderWidth: 1,
                      borderColor: c.border,
                    }}
                  >
                    <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                      <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>Процессы cgroup</Text>
                      <Text style={{ color: c.foreground, fontSize: 12, fontWeight: "600" }}>
                        {w.stats.processes ?? "—"}
                      </Text>
                    </View>
                    <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                      <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>Время работы агентов за 24 ч</Text>
                      <Text style={{ color: c.foreground, fontSize: 12, fontWeight: "600" }}>
                        {duration(w.activity.agentMs)}
                      </Text>
                    </View>
                    <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                      <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>Последний запрос в Paseo</Text>
                      <Text style={{ color: c.foreground, fontSize: 12 }}>
                        {when(w.activity.lastMessage)}
                      </Text>
                    </View>
                    <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                      <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>Последний вход по SSH</Text>
                      <Text style={{ color: c.foreground, fontSize: 12 }}>
                        {when(w.activity.lastSsh)}
                      </Text>
                    </View>
                  </View>
                </View>
              ) : (
                <View
                  style={{
                    backgroundColor: c.surface2,
                    borderRadius: 9,
                    padding: 16,
                    alignItems: "center",
                    gap: 6,
                    borderWidth: 1,
                    borderColor: c.border,
                  }}
                >
                  <Icon name="ServerOff" size={24} color={c.foregroundMuted} />
                  <Text style={{ color: c.foreground, fontSize: 13, fontWeight: "600", marginTop: 4 }}>
                    Изолированная среда не активна
                  </Text>
                  <Text style={{ color: c.foregroundMuted, fontSize: 12, textAlign: "center" }}>
                    Контейнер {w.container} ожидает создания или запуска на сервере. Метрики cgroup и Paseo подключатся автоматически сразу после старта.
                  </Text>
                </View>
              )}
            </View>
          );
        })}
      </View>
    </ScrollView>
  );
}
