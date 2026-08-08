import type { ReactNode } from "react";
import { Description, Input, Label, Switch, TextArea, TextField } from "@heroui/react";
import { NativeSelect } from "@heroui-pro/react/native-select";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faChevronDown } from "@fortawesome/free-solid-svg-icons";

interface FieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  description?: string;
  placeholder?: string;
  type?: "text" | "number" | "password" | "datetime-local";
  min?: number;
  max?: number;
  required?: boolean;
  disabled?: boolean;
  mono?: boolean;
  name?: string;
}

export function Field({
  label,
  value,
  onChange,
  description,
  placeholder,
  type = "text",
  min,
  max,
  required,
  disabled,
  mono,
  name,
}: FieldProps) {
  return (
    <TextField
      fullWidth
      variant="secondary"
      name={name ?? label.toLowerCase().replaceAll(" ", "-")}
      value={value}
      onChange={onChange}
      type={type}
      {...(required ? { isRequired: true } : {})}
      {...(disabled ? { isDisabled: true } : {})}
    >
      <Label>{label}</Label>
      <Input
        {...(mono ? { className: "font-mono text-xs" } : {})}
        {...(placeholder ? { placeholder } : {})}
        {...(min === undefined ? {} : { min })}
        {...(max === undefined ? {} : { max })}
      />
      {description ? <Description>{description}</Description> : null}
    </TextField>
  );
}

interface AreaFieldProps extends Omit<FieldProps, "type" | "min" | "max"> {
  rows?: number;
}

export function AreaField({
  label,
  value,
  onChange,
  description,
  placeholder,
  rows = 4,
  required,
  mono,
  name,
}: AreaFieldProps) {
  return (
    <TextField
      fullWidth
      variant="secondary"
      name={name ?? label.toLowerCase().replaceAll(" ", "-")}
      value={value}
      onChange={onChange}
      {...(required ? { isRequired: true } : {})}
    >
      <Label>{label}</Label>
      <TextArea
        {...(mono ? { className: "font-mono text-xs" } : {})}
        {...(placeholder ? { placeholder } : {})}
        rows={rows}
      />
      {description ? <Description>{description}</Description> : null}
    </TextField>
  );
}

interface SelectFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
  description?: string;
  disabled?: boolean;
}

export function SelectField({
  label,
  value,
  onChange,
  children,
  description,
  disabled,
}: SelectFieldProps) {
  return (
    <label className="flex min-w-0 flex-col gap-1.5 text-sm font-medium text-foreground">
      <span>{label}</span>
      <NativeSelect fullWidth variant="secondary">
        <NativeSelect.Trigger
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.currentTarget.value)}
          aria-label={label}
        >
          {children}
        </NativeSelect.Trigger>
        <NativeSelect.Indicator>
          <FontAwesomeIcon icon={faChevronDown} className="size-3" />
        </NativeSelect.Indicator>
      </NativeSelect>
      {description ? <span className="px-1 text-xs font-normal text-muted">{description}</span> : null}
    </label>
  );
}

interface SwitchRowProps {
  label: string;
  description: string;
  selected: boolean;
  onChange: (selected: boolean) => void;
  disabled?: boolean;
}

export function SwitchRow({
  label,
  description,
  selected,
  onChange,
  disabled,
}: SwitchRowProps) {
  return (
    <Switch
      className="flex w-full items-center justify-between gap-4 rounded-2xl px-1 py-2"
      isSelected={selected}
      onChange={onChange}
      {...(disabled ? { isDisabled: true } : {})}
    >
      <Switch.Content>
        <span className="block text-sm font-medium text-foreground">{label}</span>
        <span className="mt-0.5 block text-xs leading-5 text-muted">{description}</span>
      </Switch.Content>
      <Switch.Control>
        <Switch.Thumb />
      </Switch.Control>
    </Switch>
  );
}
