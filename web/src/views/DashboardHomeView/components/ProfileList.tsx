import React from "react";
import { Card, Button, Intent, NonIdealState } from "@blueprintjs/core";
import { ChevronRight, Trash2, Edit2, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import { clsx } from "clsx";
import type { Profile } from "../../../types/auth";
import { createSpaLinkClickHandler } from "../../../utils/navigation";

interface ProfileListProps {
  profiles: Profile[];
  selectedProfileId?: string | null;
  targetSection?: string;
  onSelect: (p: Profile) => void;
  onRename: (p: Profile) => void;
  onDelete: (e: React.MouseEvent, id: string) => void;
}

export const ProfileList: React.FC<ProfileListProps> = ({
  profiles,
  selectedProfileId,
  targetSection = "stats",
  onSelect,
  onRename,
  onDelete,
}) => {
  const { t } = useTranslation();

  return (
    <div
      className={clsx(
        "grid gap-3",
        profiles.length > 1 && "md:grid-cols-2 2xl:grid-cols-3 2xl:gap-4"
      )}
    >
      {profiles.map((p: Profile) => {
        const targetPath = `/dash/${p.id}/${targetSection}`;
        const isSelected = selectedProfileId === p.id;
        return (
          <Card
            key={p.id}
            interactive
            className={clsx(
              "relative flex justify-between items-center p-4 dark:bg-gray-900 rounded-xl border",
              isSelected
                ? "border-blue-500/70 dark:border-blue-500/70 ring-1 ring-blue-500/20"
                : "border-gray-200 dark:border-gray-800"
            )}
          >
            <a
              href={targetPath}
              onClick={createSpaLinkClickHandler(targetPath, () => onSelect(p))}
              aria-label={p.name}
              className="absolute inset-0 z-0 rounded-xl focus:outline-none"
            />
            <div className="flex flex-col flex-1 min-w-0 pointer-events-none relative z-10">
              <div className="flex items-center min-w-0">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    onRename(p);
                  }}
                  aria-label={t("common.rename", "Rename")}
                  title={t("common.rename", "Rename")}
                  className="pointer-events-auto group/rename inline-flex items-center gap-1.5 max-w-full min-w-0 bg-transparent border-0 p-0 text-left font-bold text-base text-gray-900 dark:text-white cursor-pointer"
                >
                  <span className="truncate">{p.name}</span>
                  <Edit2
                    size={13}
                    className="shrink-0 opacity-30 group-hover/rename:opacity-100 transition-opacity"
                  />
                </button>
              </div>
              <code className="text-gray-400 text-[10px] font-mono uppercase mt-0.5">
                {p.id}
              </code>
            </div>
            <div className="flex items-center gap-1 shrink-0 relative z-10">
              <Button
                variant="minimal"
                intent={Intent.DANGER}
                icon={<Trash2 size={16} />}
                aria-label={t("common.delete", "Delete")}
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(e, p.id);
                }}
              />
              <ChevronRight size={18} className="text-gray-300 pointer-events-none" />
            </div>
          </Card>
        );
      })}
      {profiles.length === 0 && (
        <NonIdealState
          icon={<ShieldCheck size={48} className="text-gray-300" />}
          title={t("common.welcome")}
          description={t("common.createProfileToStart")}
        />
      )}
    </div>
  );
};
