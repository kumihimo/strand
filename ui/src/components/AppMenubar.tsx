import type { MenuAction, MenuDef, MenuId } from '../lib/menubar.ts';
import { Menubar, MenubarContent, MenubarItem, MenubarMenu, MenubarSeparator, MenubarShortcut, MenubarTrigger } from './ui/menubar.tsx';

type P = {
  menus: MenuDef[];
  /** The open menu, '' for none: Alt+F and the like open one from the keyboard. */
  open: MenuId | '';
  onOpenChange: (id: MenuId | '') => void;
  onAction: (a: MenuAction) => void;
};

/** File, View, Go and Help in the header (ADR 0030). Radix gives it the menu keys, Escape and outside click. */
export function AppMenubar({ menus, open, onOpenChange, onAction }: P) {
  if (menus.length === 0) return null;
  return (
    <Menubar value={open} onValueChange={(v) => onOpenChange(v as MenuId | '')} className="h-auto gap-0 border-0 bg-transparent p-0 shadow-none" aria-label="Menu">
      {menus.map((m) => (
        <MenubarMenu key={m.id} value={m.id}>
          <MenubarTrigger className="px-2 py-1 font-normal">{m.label}</MenubarTrigger>
          <MenubarContent align="start" className="min-w-56">
            {m.items.map((e, i) =>
              e === 'separator' ? (
                <MenubarSeparator key={`sep-${i}`} />
              ) : (
                <MenubarItem key={e.action} onSelect={() => onAction(e.action)}>
                  {e.label}
                  {e.shortcut && <MenubarShortcut>{e.shortcut}</MenubarShortcut>}
                </MenubarItem>
              ),
            )}
          </MenubarContent>
        </MenubarMenu>
      ))}
    </Menubar>
  );
}
