import React from "react";
import { PopoverNext, Menu, MenuItem, MenuDivider, Button } from "@blueprintjs/core";
import { ChevronDown, Check } from "lucide-react";
import { clsx } from "clsx";

export interface MinimalSelectOption {
  value: string;
  label: string;
  subLabel?: string;
  icon?: React.ReactNode;
}

export interface MinimalSelectGroup {
  label?: string;
  options: MinimalSelectOption[];
}

export interface MinimalSelectProps {
  value: string;
  onChange: (value: string) => void;
  options?: MinimalSelectOption[];
  groups?: MinimalSelectGroup[];
  placeholder?: string;
  disabled?: boolean;
  fill?: boolean;
  alignRight?: boolean;
  className?: string;
  buttonClassName?: string;
  menuClassName?: string;
  leadingIcon?: React.ReactNode;
}

/**
 * Unified lightweight dropdown built on PopoverNext + Menu, matching the
 * header Profile switcher & Setup Access Point selector aesthetic.
 */
export const MinimalSelect: React.FC<MinimalSelectProps> = ({
  value,
  onChange,
  options,
  groups,
  placeholder = "",
  disabled = false,
  fill = false,
  alignRight = false,
  className,
  buttonClassName,
  menuClassName,
  leadingIcon,
}) => {
  const resolvedGroups: MinimalSelectGroup[] = React.useMemo(() => {
    if (groups && groups.length > 0) return groups;
    return [{ options: options || [] }];
  }, [groups, options]);

  const activeOption = React.useMemo(() => {
    for (const g of resolvedGroups) {
      const found = g.options.find((opt) => opt.value === value);
      if (found) return found;
    }
    return null;
  }, [resolvedGroups, value]);

  const menuContent = (
    <Menu className={clsx("max-h-72 overflow-y-auto", menuClassName)}>
      {resolvedGroups.map((group, groupIdx) => (
        <React.Fragment key={group.label || `group-${groupIdx}`}>
          {group.label && (
            <>
              {groupIdx > 0 && <MenuDivider />}
              <li className="px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-gray-500 dark:text-gray-400 select-none">
                {group.label}
              </li>
            </>
          )}
          {group.options.map((opt) => {
            const isCurrent = opt.value === value;
            return (
              <MenuItem
                key={opt.value}
                text={opt.label}
                label={opt.subLabel}
                active={isCurrent}
                icon={
                  opt.icon ? (
                    <span className="inline-flex items-center justify-center w-4 shrink-0">
                      {opt.icon}
                    </span>
                  ) : isCurrent ? (
                    <Check size={14} />
                  ) : (
                    <span className="inline-block w-3.5" />
                  )
                }
                labelElement={
                  opt.icon && isCurrent ? <Check size={14} className="text-blue-500" /> : undefined
                }
                onClick={() => onChange(opt.value)}
              />
            );
          })}
        </React.Fragment>
      ))}
    </Menu>
  );

  return (
    <PopoverNext
      placement={alignRight ? "bottom-end" : "bottom-start"}
      animation="minimal"
      arrow={false}
      usePortal={true}
      portalClassName="z-20000"
      disabled={disabled}
      fill={fill}
      className={className}
      content={menuContent}
    >
      <Button
        variant="minimal"
        disabled={disabled}
        fill={fill}
        className={clsx(
          "font-medium! px-2! py-1! rounded-md! border border-gray-200/80 dark:border-slate-700/80 bg-gray-50/70! dark:bg-slate-800/70! hover:bg-gray-100! dark:hover:bg-slate-800! transition-colors",
          fill && "justify-between!",
          buttonClassName
        )}
        endIcon={<ChevronDown size={14} className="opacity-65 shrink-0" />}
      >
        <span className="inline-flex items-center gap-1.5 min-w-0">
          {leadingIcon || activeOption?.icon}
          <span className="truncate max-w-44 md:max-w-60 inline-block align-middle">
            {activeOption?.label || placeholder}
          </span>
        </span>
      </Button>
    </PopoverNext>
  );
};
