import React from "react";
import { Card, Button, Intent, NonIdealState } from "@blueprintjs/core";
import { ChevronRight, Trash2, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Profile } from "../../../types/auth";
import { createSpaLinkClickHandler } from "../../../utils/navigation";

interface ProfileListProps {
  profiles: Profile[];
  targetSection?: string;
  onSelect: (p: Profile) => void;
  onDelete: (e: React.MouseEvent, id: string) => void;
}

export const ProfileList: React.FC<ProfileListProps> = ({
  profiles,
  targetSection = "setup",
  onSelect,
  onDelete,
}) => {
  const { t } = useTranslation();

  return (
    <div className="grid gap-3">
      {profiles.map((p: Profile) => {
        const targetPath = `/dash/${p.id}/${targetSection}`;
        return (
          <Card
            key={p.id}
            interactive
            className="relative flex justify-between items-center p-4 dark:bg-gray-900 dark:border-gray-800 rounded-xl border border-gray-200"
          >
            <a
              href={targetPath}
              onClick={createSpaLinkClickHandler(targetPath, () => onSelect(p))}
              className="flex flex-col flex-1 min-w-0 text-inherit no-underline hover:no-underline after:absolute after:inset-0 after:content-['']"
            >
              <span className="font-bold text-base dark:text-white truncate">
                {p.name}
              </span>
              <code className="text-gray-400 text-[10px] font-mono uppercase mt-0.5">
                {p.id}
              </code>
            </a>
            <div className="flex items-center gap-1 shrink-0">
              <Button
                className="relative z-10"
                variant="minimal"
                intent={Intent.DANGER}
                icon={<Trash2 size={16} />}
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
