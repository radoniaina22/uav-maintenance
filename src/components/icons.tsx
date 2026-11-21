/* Jeu d'icônes SVG au trait (24×24, trait 1,8) */
const PATHS: Record<string, string> = {
  dashboard: 'M4 4h7v9H4zM13 4h7v5h-7zM13 11h7v9h-7zM4 15h7v5H4z',
  stats: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  flight: 'M2.5 13.5 11 11V5.2a1.5 1.5 0 0 1 3 0V11l8.5 2.5v2L14 14v4l2.5 1.6V21L12.5 20l-4 1v-1.4L11 18v-4l-8.5 1.5z',
  wind: 'M3 8.5h10.5a2.75 2.75 0 1 0-2.6-3.6M3 12.5h15a3 3 0 1 1-2.9 3.8M3 16.5h7',
  book: 'M5 4.5A2.5 2.5 0 0 1 7.5 2H19v16H7.5A2.5 2.5 0 0 0 5 20.5zM5 20.5A2.5 2.5 0 0 0 7.5 23H19v-5M9 6.5h6M9 10h4',
  alert: 'M12 3.5 2.5 20h19zM12 10v4.5M12 17.2v.1',
  drone: 'M9 10h6v4H9zM9 10 6.2 7.2M15 10l2.8-2.8M9 14l-2.8 2.8M15 14l2.8 2.8M3.5 6h5M15.5 6h5M3.5 18h5M15.5 18h5',
  chip: 'M7 7h10v10H7zM10 10h4v4h-4zM10 2.5V7M14 2.5V7M10 17v4.5M14 17v4.5M2.5 10H7M2.5 14H7M17 10h4.5M17 14h4.5',
  battery: 'M3 7h15a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1zM22 10.5v3M5.5 10v4M9 10v4M12.5 10v4',
  users: 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2.5 20a6.5 6.5 0 0 1 13 0M16 4.3a3.5 3.5 0 0 1 0 6.4M18.5 14.5a6.5 6.5 0 0 1 3 5.5',
  health: 'M4 4h16v16H4zM12 8v8M8 12h8',
  pin: 'M12 21s-7-6.1-7-11.5a7 7 0 0 1 14 0C19 14.9 12 21 12 21zM12 12a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
  shield: 'M12 2.5 4 5.5v6c0 4.8 3.4 8.6 8 10 4.6-1.4 8-5.2 8-10v-6zM9 12l2.2 2.2L15.5 10',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20.5 20.5 16 16',
  plus: 'M12 5v14M5 12h14',
  menu: 'M4 7h16M4 12h16M4 17h16',
  chevronLeft: 'M15 5l-7 7 7 7',
  chevronRight: 'M9 5l7 7-7 7',
  logout: 'M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 16l-4-4 4-4M6 12h10',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3.2 2',
  enter: 'M20 5v6a3 3 0 0 1-3 3H5M9 10l-4 4 4 4',
  wrench: 'M14.7 6.3a4 4 0 0 0-5.4 5.4L3.5 17.5a1.8 1.8 0 0 0 2.5 2.5l5.8-5.8a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.3-.4-.4-2.3z',
  box: 'M3.5 7.5 12 3l8.5 4.5v9L12 21l-8.5-4.5zM3.5 7.5 12 12l8.5-4.5M12 12v9',
  trophy: 'M8 4h8v5a4 4 0 0 1-8 0zM8 6H4.5a3 3 0 0 0 3.5 4M16 6h3.5a3 3 0 0 1-3.5 4M12 13v4M8.5 21h7M9.5 17h5v4h-5z',
  bell: 'M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2H4.5zM10 21a2.2 2.2 0 0 0 4 0',
  pen: 'M4 20h4L19.5 8.5a2.1 2.1 0 0 0-3-3L5 17zM14.5 7.5l2 2',
  bolt:'M13 2.5 4.5 13.5H11l-1 8 8.5-11H12z',
  sparkle:'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z',
  scan: 'M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M4 12h16',
};

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 18, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg className={`icon${className ? ` ${className}` : ''}`} width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={PATHS[name]} />
    </svg>
  );
}
