import { Children, isValidElement, useRef, type ReactNode } from 'react';
import { MoreHorizontal } from 'lucide-react';
import { Dialog, DialogContent } from './components/ui/dialog';
import type { IconComponent } from './lib/icon-context';
import { Accordion, AccordionItem, AccordionTrigger, AccordionContent } from './components/ui/accordion';
import { Button as FluidButton, type ButtonProps } from './components/ui/button';
import { DropdownMenu, DropdownTrigger, DropdownContent } from './components/ui/dropdown';
import { MenuItem } from './components/ui/menu-item';

/** App operations retain focus while a queued row action is working. */
export function Button({ working = false, onClick, variant = 'tertiary', type = 'button', children, size, ...props }: ButtonProps & { working?: boolean }) {
  const parts = Children.toArray(children);
  const first = parts[0];
  const icon = isValidElement<{ size?: number }>(first) && typeof first.type !== 'string' && typeof first.props.size === 'number' ? first.type as IconComponent : undefined;
  const iconOnly = !!icon && parts.length === 1;
  return <FluidButton {...props} type={type} variant={variant} size={size ?? (iconOnly ? 'icon' : undefined)} leadingIcon={iconOnly ? undefined : icon} aria-disabled={working || undefined} aria-busy={working || undefined}
    onClick={event => { if (working) { event.preventDefault(); return; } onClick?.(event); }}>{icon && !iconOnly ? parts.slice(1) : children}</FluidButton>;
}

export function RowMenu({ label, actions }: { label: string; actions: Array<{ label: string; disabled?: boolean; destructive?: boolean; onSelect: (trigger: HTMLButtonElement | null) => void }> }) {
  const trigger = useRef<HTMLButtonElement>(null);
  return <DropdownMenu size="compact">
    <DropdownTrigger render={<FluidButton ref={trigger} variant="ghost" size="icon" aria-label={label}><MoreHorizontal size={18} /></FluidButton>} />
    <DropdownContent align="end" className="w-48">
      {actions.map((action, index) => <MenuItem key={action.label} index={index} label={action.label} disabled={action.disabled}
        className={action.destructive ? '[&_span]:text-red-400' : undefined} onSelect={() => action.onSelect(trigger.current)} />)}
    </DropdownContent>
  </DropdownMenu>;
}

/** Keep the last content mounted for the registry Dialog's spring exit. */
export function AppDialog({ open, onOpenChange, className, size = 'lg', onCloseAutoFocus, children }: {
  open: boolean; onOpenChange: (open: boolean) => void; className?: string; size?: 'sm' | 'lg' | 'xl';
  onCloseAutoFocus?: (event: Event) => void; children: ReactNode;
}) {
  const last = useRef({ children, className, size });
  if (open) last.current = { children, className, size };
  const content = open ? { children, className, size } : last.current;
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent size={content.size} className={content.className}
    showCloseButton={false} aria-describedby={undefined} onCloseAutoFocus={onCloseAutoFocus}>{content.children}</DialogContent></Dialog>;
}

export function AppAccordion({ title, triggerLabel, className = '', children }: {
  title: ReactNode; triggerLabel?: string; className?: string; children: ReactNode;
}) {
  return <Accordion size="compact" className={`app-accordion w-auto min-w-0 ${className}`}>
    <AccordionItem value="content" highlight="trigger">
      <AccordionTrigger className="app-accordion-trigger w-fit max-w-full gap-1.5 px-0" aria-label={triggerLabel}>{title}</AccordionTrigger>
      <AccordionContent className="app-accordion-content [&>div]:px-0 [&>div]:pb-0" >{children}</AccordionContent>
    </AccordionItem>
  </Accordion>;
}
