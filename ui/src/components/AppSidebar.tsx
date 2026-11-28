import { useEffect, useRef } from 'react';
import { GitPullRequestIcon, LayersIcon, NewspaperIcon, SettingsIcon, SquareKanbanIcon, type LucideIcon } from 'lucide-react';
import { SIDEBAR_VIEWS, navCount, type SidebarView } from '../lib/views.ts';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from './ui/sidebar.tsx';

const ICONS: Record<SidebarView, LucideIcon> = {
  brief: NewspaperIcon,
  board: SquareKanbanIcon,
  epics: LayersIcon,
  review: GitPullRequestIcon,
  settings: SettingsIcon,
};

type P = { current: string; counts: { review: number; approve: number } | undefined };

function Item({ view, label, current, counts }: P & { view: SidebarView; label: string }) {
  const Icon = ICONS[view];
  const count = navCount(view, counts);
  const active = current === view;
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild isActive={active} tooltip={count ? `${label} (${count.title})` : label}>
        <a href={`#/${view}`} aria-current={active ? 'page' : undefined}>
          <Icon />
          <span>{label}</span>
        </a>
      </SidebarMenuButton>
      {count && (
        <>
          <SidebarMenuBadge title={count.title}>{count.n}</SidebarMenuBadge>
          {/* Collapsed to icons the badge is hidden; a dot on the icon says there is something waiting. */}
          <span className="navdot" aria-hidden />
        </>
      )}
    </SidebarMenuItem>
  );
}

/** Hover this long before the collapsed sidebar expands, so passing over it on the way elsewhere does not. */
const PEEK_DELAY_MS = 250;

/**
 * The views, VS Code style (ADR 0030): a column of icons under the title bar. Hovering expands it over the page
 * with its labels; the header toggle, View > Toggle Sidebar or Ctrl+B pin it open.
 */
export function AppSidebar({ onPeek, ...p }: P & { onPeek: (on: boolean) => void }) {
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const enter = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => onPeek(true), PEEK_DELAY_MS);
  };
  const leave = () => {
    clearTimeout(timer.current);
    onPeek(false);
  };
  const top = SIDEBAR_VIEWS.filter((v) => v.place === 'top');
  const foot = SIDEBAR_VIEWS.filter((v) => v.place === 'foot');
  return (
    <Sidebar collapsible="icon" aria-label="Views" onMouseEnter={enter} onMouseLeave={leave} className="top-(--header-height) h-[calc(100svh-var(--header-height))]!">
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {top.map((v) => (
                <Item key={v.view} view={v.view} label={v.label} {...p} />
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          {foot.map((v) => (
            <Item key={v.view} view={v.view} label={v.label} {...p} />
          ))}
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
