/**
 * Shared responsive container width classes supporting standard laptops,
 * QHD (2560px), and 4K/ultrawide (3840px+) viewports using `rem` caps so
 * containers scale harmoniously with high-DPI root font scaling.
 */

/** Standard management, setup, rules, filtering, settings, account, and system views. */
export const PAGE_CONTAINER_STANDARD =
  "max-w-5xl 2xl:max-w-[90rem] min-[2200px]:max-w-[112rem]";

/** High-density monitoring, card grids, analytics dashboards, and log tables. */
export const PAGE_CONTAINER_WIDE =
  "max-w-7xl 2xl:max-w-[100rem] min-[2200px]:max-w-[130rem]";

/** Collection/profile hub scaling from centered card stack to multi-column grid. */
export const PAGE_CONTAINER_COLLECTIONS =
  "max-w-2xl lg:max-w-4xl 2xl:max-w-6xl min-[2200px]:max-w-[92rem]";
