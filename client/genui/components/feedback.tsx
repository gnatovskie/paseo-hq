// Modified by GNATOVSKIE for integration into Paseo HQ, 2026-11-10.
// Comments, inline edits and "Other…" boxes. None of them sends anything: each
// writes one entry into the chat's reply queue, which the next Send carries.
import { Icon, TextInput } from "@getpaseo/plugin/client/react-native";
import React, { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { commentText, editText } from "../../../shared/genui/logic/reply";
import { optionalText, type Props } from "../../../shared/genui/logic/values";
import { usePersistedState, useUiRuntime } from "../runtime";

type Fields = Readonly<Record<string, string>>;

interface ItemNote {
  readonly comment?: string;
  readonly edits?: Fields;
}

type Notes = Readonly<Record<string, ItemNote>>;

function acceptNotes(stored: unknown): Notes | null {
  return typeof stored === "object" && stored !== null && !Array.isArray(stored) ? (stored as Notes) : null;
}

/**
 * Per-item comments and edits for a list component. `fields` gives an item's
 * text with the user's edits applied; `controls` renders its Comment and Edit
 * actions. With neither option on, both are no-ops.
 */
export function useItemFeedback(scope: string, options: { comments: boolean; editable: boolean }) {
  const [notes, setNotes] = usePersistedState<Notes>(`feedback:${scope}`, {}, acceptNotes);
  const { setQueued } = useUiRuntime();

  const update = (index: number, label: string, original: Fields, note: ItemNote) => {
    setNotes((previous) => ({ ...previous, [index]: note }));
    setQueued(`${scope}:${index}:comment`, note.comment ? commentText(label, note.comment) : null);
    setQueued(`${scope}:${index}:edit`, note.edits ? editText(label, original, note.edits) : null);
  };

  return {
    fields<T extends Fields>(index: number, original: T): T {
      return { ...original, ...(notes[index]?.edits ?? {}) };
    },
    controls(index: number, label: string, original: Fields, leading?: React.ReactNode): React.ReactNode {
      if (!options.comments && !options.editable) return leading ?? null;
      return (
        <ItemFeedback
          note={notes[index] ?? {}}
          original={original}
          comments={options.comments}
          editable={options.editable}
          leading={leading}
          onChange={(note) => update(index, label, original, note)}
        />
      );
    },
  };
}

function ItemFeedback({
  note,
  original,
  comments,
  editable,
  leading,
  onChange,
}: {
  note: ItemNote;
  original: Fields;
  comments: boolean;
  editable: boolean;
  /** Shown first in the item's action row, as Findings' "Fix this". */
  leading?: React.ReactNode;
  onChange(note: ItemNote): void;
}) {
  const { theme, answer, superseded } = useUiRuntime();
  const [mode, setMode] = useState<"idle" | "comment" | "edit">("idle");
  const [draft, setDraft] = useState("");
  const [edits, setEdits] = useState<Fields>({});
  const open = !answer && !superseded;
  const edited = note.edits !== undefined && Object.keys(original).some((field) => (note.edits?.[field] ?? original[field]) !== original[field]);

  if (mode === "comment") {
    return (
      <Editor
        fields={{ comment: draft }}
        multiline
        placeholder="Comment"
        onChange={(next) => setDraft(next.comment ?? "")}
        onCancel={() => setMode("idle")}
        onSave={() => {
          const comment = draft.trim();
          onChange({ ...note, comment: comment === "" ? undefined : comment });
          setMode("idle");
        }}
      />
    );
  }
  if (mode === "edit") {
    return (
      <Editor
        fields={edits}
        onChange={setEdits}
        onCancel={() => setMode("idle")}
        onSave={() => {
          onChange({ ...note, edits });
          setMode("idle");
        }}
      />
    );
  }

  const startComment = () => {
    setDraft(note.comment ?? "");
    setMode("comment");
  };
  return (
    <View style={{ gap: 6 }}>
      {note.comment ? (
        <View style={{ flexDirection: "row", gap: 6, alignItems: "flex-start" }}>
          <View style={{ paddingTop: 2 }}>
            <Icon name="MessageSquare" size={12} color={theme.colors.foregroundMuted} />
          </View>
          <Pressable disabled={!open} onPress={startComment} style={{ flex: 1 }}>
            <Text style={{ color: theme.colors.foreground, fontSize: 12 }}>{note.comment}</Text>
          </Pressable>
          {open ? (
            <Pressable accessibilityRole="button" accessibilityLabel="Remove comment" onPress={() => onChange({ ...note, comment: undefined })}>
              <Icon name="Trash2" size={12} color={theme.colors.foregroundMuted} />
            </Pressable>
          ) : null}
        </View>
      ) : null}
      {open ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 12 }}>
          {leading}
          {comments && !note.comment ? <QuietAction icon="MessageSquare" label="Comment" onPress={startComment} /> : null}
          {editable ? (
            <QuietAction
              icon="Edit"
              label="Edit"
              onPress={() => {
                setEdits({ ...original, ...(note.edits ?? {}) });
                setMode("edit");
              }}
            />
          ) : null}
          {editable && edited ? <QuietAction label="Undo edit" onPress={() => onChange({ ...note, edits: undefined })} /> : null}
        </View>
      ) : (
        leading
      )}
    </View>
  );
}

function QuietAction({ icon, label, onPress }: { icon?: string; label: string; onPress(): void }) {
  const { theme } = useUiRuntime();
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
      {icon ? <Icon name={icon} size={12} color={theme.colors.foregroundMuted} /> : null}
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{label}</Text>
    </Pressable>
  );
}

/** One text box per field, with Save and Cancel. */
function Editor({
  fields,
  multiline = false,
  placeholder,
  onChange,
  onSave,
  onCancel,
}: {
  fields: Fields;
  multiline?: boolean;
  placeholder?: string;
  onChange(fields: Fields): void;
  onSave(): void;
  onCancel(): void;
}) {
  const { theme } = useUiRuntime();
  const many = Object.keys(fields).length > 1;
  return (
    <View style={{ gap: 6 }}>
      {Object.entries(fields).map(([field, value]) => (
        <TextInput
          key={field}
          value={value}
          multiline={multiline || field === "detail"}
          autoFocus={!many}
          placeholder={placeholder ?? field}
          placeholderTextColor={theme.colors.foregroundMuted}
          onChangeText={(next) => onChange({ ...fields, [field]: next })}
          style={{
            borderRadius: 6,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: theme.colors.border,
            backgroundColor: theme.colors.surface1,
            color: theme.colors.foreground,
            paddingHorizontal: 8,
            paddingVertical: 6,
            fontSize: 12.5,
            minHeight: multiline || field === "detail" ? 56 : undefined,
          }}
        />
      ))}
      <View style={{ flexDirection: "row", gap: 8 }}>
        <SmallButton label="Save" primary onPress={onSave} />
        <SmallButton label="Cancel" onPress={onCancel} />
      </View>
    </View>
  );
}

function SmallButton({ label, primary = false, onPress }: { label: string; primary?: boolean; onPress(): void }) {
  const { theme } = useUiRuntime();
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={{
        paddingHorizontal: 10,
        paddingVertical: 5,
        borderRadius: 6,
        backgroundColor: primary ? theme.colors.accent : theme.colors.surface2,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: primary ? theme.colors.accent : theme.colors.border,
      }}
    >
      <Text style={{ color: primary ? theme.colors.accentForeground : theme.colors.foreground, fontSize: 12, fontWeight: "600" }}>
        {label}
      </Text>
    </Pressable>
  );
}

/** "Other…": free-form feedback the agent did not offer a button for. */
export function Other({ props }: { props: Props }) {
  const { theme, run, setQueued, queued: queuedText, answer, superseded } = useUiRuntime();
  const label = optionalText(props.label) ?? "Other…";
  const placeholder = optionalText(props.placeholder) ?? "Add more feedback";
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const id = `other:${label}`;
  const queued = queuedText(id);

  if (answer || superseded) return null;

  // Open or queued, the box takes the whole line of its button group.
  if (queued !== null && !open) {
    return (
      <View style={{ width: "100%", flexDirection: "row", gap: 8, alignItems: "flex-start" }}>
        <View style={{ paddingTop: 2 }}>
          <Icon name="MessageSquare" size={12} color={theme.colors.foregroundMuted} />
        </View>
        <Text style={{ color: theme.colors.foreground, fontSize: 12.5, flex: 1 }}>{queued}</Text>
        <QuietAction
          label="Edit"
          onPress={() => {
            setDraft(queued);
            setOpen(true);
          }}
        />
        <QuietAction label="Remove" onPress={() => setQueued(id, null)} />
      </View>
    );
  }

  if (!open) {
    return (
      <Pressable
        accessibilityRole="button"
        onPress={() => setOpen(true)}
        style={{
          alignSelf: "flex-start",
          paddingHorizontal: 12,
          paddingVertical: 7,
          borderRadius: 8,
          backgroundColor: theme.colors.surface2,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: theme.colors.border,
        }}
      >
        <Text style={{ color: theme.colors.foreground, fontSize: 12.5, fontWeight: "600" }}>{label}</Text>
      </Pressable>
    );
  }

  const text = draft.trim();
  return (
    <View style={{ width: "100%", gap: 6 }}>
      <TextInput
        value={draft}
        multiline
        autoFocus
        placeholder={placeholder}
        placeholderTextColor={theme.colors.foregroundMuted}
        onChangeText={setDraft}
        style={{
          borderRadius: 8,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: theme.colors.border,
          backgroundColor: theme.colors.surface1,
          color: theme.colors.foreground,
          paddingHorizontal: 10,
          paddingVertical: 8,
          fontSize: 13,
          minHeight: 64,
        }}
      />
      <View style={{ flexDirection: "row", gap: 8 }}>
        <SmallButton
          label="Send"
          primary
          onPress={() => {
            if (text === "") return;
            setQueued(id, null);
            setOpen(false);
            void run([{ kind: "action", type: "send", text }]);
          }}
        />
        <SmallButton
          label="Add to reply"
          onPress={() => {
            setQueued(id, text === "" ? null : text);
            setOpen(false);
          }}
        />
        <SmallButton label="Cancel" onPress={() => setOpen(false)} />
      </View>
    </View>
  );
}
