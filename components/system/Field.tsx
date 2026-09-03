'use client';

import { AlertCircle, Check, Minus } from 'lucide-react';
import { useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';

import { cn } from '@/lib/utils';

/**
 * Form controls for the product. One definition each, so a field looks and
 * behaves the same on every page.
 *
 * What each of these guarantees, because it is easy to get wrong by hand:
 * · A real <label> tied to the control, always visible. A placeholder is an
 *   example, never the label — it disappears exactly when you need it.
 * · Help text and error text are linked with aria-describedby, so a screen
 *   reader reads them with the field rather than after it.
 * · An invalid field carries aria-invalid, a red border AND an error message
 *   with an icon. Never colour alone.
 * · Errors sit under the field they belong to, not in a summary at the top.
 */

type FieldShellProps = {
  id: string;
  label: ReactNode;
  help?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  optional?: boolean;
  hideLabel?: boolean;
  className?: string;
  children: ReactNode;
};

/** Label + control + help + error. Wrap a custom control with this to inherit the wiring. */
export function Field({ id, label, help, error, required, optional, hideLabel, className, children }: FieldShellProps) {
  return (
    <div className={cn('field', className)}>
      <label htmlFor={id} className={cn('field__label', hideLabel && 'sr-only')}>
        {label}
        {required ? (
          <span className="field__req" aria-hidden="true">
            *
          </span>
        ) : null}
        {optional ? <span className="field__opt">(optional)</span> : null}
      </label>
      {children}
      {help && !error ? (
        <p id={`${id}-help`} className="field__help">
          {help}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} className="field__error">
          <AlertCircle aria-hidden="true" />
          <span>{error}</span>
        </p>
      ) : null}
    </div>
  );
}

function describedBy(id: string, help?: ReactNode, error?: ReactNode) {
  const ids = [help && !error ? `${id}-help` : null, error ? `${id}-error` : null].filter(Boolean);
  return ids.length ? ids.join(' ') : undefined;
}

type Shared = { label: ReactNode; help?: ReactNode; error?: ReactNode; optional?: boolean; hideLabel?: boolean; fieldClassName?: string };

export type InputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> &
  Shared & {
    /** Tabular figures and the evidence face — use for money, rates and identifiers. */
    mono?: boolean;
    size?: 'compact' | 'md' | 'lg';
    /** Fixed leading text, e.g. a currency code. Sits inside the same focus ring. */
    prefix?: ReactNode;
    /** Fixed trailing text, e.g. a unit. */
    suffix?: ReactNode;
  };

export function Input({ label, help, error, required, optional, hideLabel, fieldClassName, mono, size = 'md', prefix, suffix, className, id, disabled, ...rest }: InputProps) {
  const auto = useId();
  const fieldId = id ?? auto;
  const control = (
    <input
      id={fieldId}
      disabled={disabled}
      required={required}
      aria-invalid={error ? true : undefined}
      aria-describedby={describedBy(fieldId, help, error)}
      className={cn(prefix || suffix ? 'control-group__field' : 'control', size === 'compact' && 'control--compact', size === 'lg' && 'control--lg', mono && 'control--mono', className)}
      {...rest}
    />
  );
  return (
    <Field id={fieldId} label={label} help={help} error={error} required={required} optional={optional} hideLabel={hideLabel} className={fieldClassName}>
      {prefix || suffix ? (
        <div className="control-group" data-invalid={error ? true : undefined} data-disabled={disabled ? true : undefined}>
          {prefix ? <span className="control-group__affix">{prefix}</span> : null}
          {control}
          {suffix ? <span className="control-group__affix">{suffix}</span> : null}
        </div>
      ) : (
        control
      )}
    </Field>
  );
}

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & Shared;

export function Textarea({ label, help, error, required, optional, hideLabel, fieldClassName, className, id, ...rest }: TextareaProps) {
  const auto = useId();
  const fieldId = id ?? auto;
  return (
    <Field id={fieldId} label={label} help={help} error={error} required={required} optional={optional} hideLabel={hideLabel} className={fieldClassName}>
      <textarea
        id={fieldId}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(fieldId, help, error)}
        className={cn('control', className)}
        {...rest}
      />
    </Field>
  );
}

export type SelectProps = Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'> & Shared & { size?: 'compact' | 'md' };

export function Select({ label, help, error, required, optional, hideLabel, fieldClassName, size = 'md', className, id, children, ...rest }: SelectProps) {
  const auto = useId();
  const fieldId = id ?? auto;
  return (
    <Field id={fieldId} label={label} help={help} error={error} required={required} optional={optional} hideLabel={hideLabel} className={fieldClassName}>
      <select
        id={fieldId}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(fieldId, help, error)}
        className={cn('control', size === 'compact' && 'control--compact', className)}
        {...rest}
      >
        {children}
      </select>
    </Field>
  );
}

type ChoiceProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & { label: ReactNode; help?: ReactNode; className?: string };

/** A value the form saves. For a setting that applies on the spot, use Switch. */
export function Checkbox({ label, help, className, id, indeterminate, ...rest }: ChoiceProps & { indeterminate?: boolean }) {
  const auto = useId();
  const fieldId = id ?? auto;
  return (
    <label htmlFor={fieldId} className={cn('choice', className)}>
      <input id={fieldId} type="checkbox" aria-describedby={help ? `${fieldId}-help` : undefined} {...rest} />
      <span className="choice__box" aria-hidden="true">
        {indeterminate ? <Minus strokeWidth={3} /> : <Check strokeWidth={3} />}
      </span>
      <span className="choice__text">
        {label}
        {help ? <span id={`${fieldId}-help`}>{help}</span> : null}
      </span>
    </label>
  );
}

export function Radio({ label, help, className, id, ...rest }: ChoiceProps) {
  const auto = useId();
  const fieldId = id ?? auto;
  return (
    <label htmlFor={fieldId} className={cn('choice', className)}>
      <input id={fieldId} type="radio" aria-describedby={help ? `${fieldId}-help` : undefined} {...rest} />
      <span className="choice__box choice__box--radio" aria-hidden="true">
        <Check strokeWidth={3} />
      </span>
      <span className="choice__text">
        {label}
        {help ? <span id={`${fieldId}-help`}>{help}</span> : null}
      </span>
    </label>
  );
}

/** A setting that takes effect immediately. Label it with the state it turns on. */
export function Switch({ checked, onCheckedChange, label, help, disabled, className }: { checked: boolean; onCheckedChange: (next: boolean) => void; label: ReactNode; help?: ReactNode; disabled?: boolean; className?: string }) {
  const id = useId();
  return (
    <div className={cn('grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3', className)}>
      <span className="choice__text">
        <label htmlFor={id} className="text-[14px] font-medium">
          {label}
        </label>
        {help ? <span id={`${id}-help`}>{help}</span> : null}
      </span>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-describedby={help ? `${id}-help` : undefined}
        disabled={disabled}
        onClick={() => onCheckedChange(!checked)}
        className="switch"
      />
    </div>
  );
}

/** Group of related fields. Use it whenever two or more inputs answer one question. */
export function FieldGroup({ legend, help, children, className, columns = 1 }: { legend: ReactNode; help?: ReactNode; children: ReactNode; className?: string; columns?: 1 | 2 }) {
  return (
    <fieldset className={cn('grid gap-3 border-0 p-0', className)}>
      <legend className="mb-1 p-0 text-[13px] font-medium text-[var(--text)]">{legend}</legend>
      {help ? <p className="field__help -mt-1">{help}</p> : null}
      <div className={cn('grid gap-3', columns === 2 && 'sm:grid-cols-2')}>{children}</div>
    </fieldset>
  );
}
