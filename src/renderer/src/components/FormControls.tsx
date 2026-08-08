import type { IconDefinition } from "@fortawesome/fontawesome-svg-core";
import { Description, Input, Label, ListBox, Select, TextArea, TextField } from "@heroui/react";
import { CellSwitch } from "@heroui-pro/react";
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

export interface SelectFieldOption {
  value: string;
  label: string;
  icon: IconDefinition;
}

interface SelectFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: SelectFieldOption[];
  description?: string;
  disabled?: boolean;
}

const EMPTY_SELECT_KEY = "__sliver_empty_option__";

function optionKey(value: string): string {
  return value === "" ? EMPTY_SELECT_KEY : value;
}

export function SelectField({
  label,
  value,
  onChange,
  options,
  description,
  disabled,
}: SelectFieldProps) {
  const selectedOption = options.find((option) => option.value === value);

  return (
    <Select
      fullWidth
      variant="secondary"
      value={optionKey(value)}
      {...(disabled ? { isDisabled: true } : {})}
      onChange={(nextValue) => {
        if (nextValue === null || Array.isArray(nextValue)) return;
        const normalized = String(nextValue);
        onChange(normalized === EMPTY_SELECT_KEY ? "" : normalized);
      }}
    >
      <Label>{label}</Label>
      <Select.Trigger>
        <Select.Value>
          {selectedOption ? (
            <span className="flex min-w-0 items-center gap-2">
              <FontAwesomeIcon
                aria-hidden
                icon={selectedOption.icon}
                className="size-3.5 shrink-0 text-muted"
              />
              <span className="truncate">{selectedOption.label}</span>
            </span>
          ) : null}
        </Select.Value>
        <Select.Indicator>
          <FontAwesomeIcon icon={faChevronDown} className="size-3" />
        </Select.Indicator>
      </Select.Trigger>
      <Select.Popover>
        <ListBox>
          {options.map((option) => (
            <ListBox.Item
              key={option.value}
              id={optionKey(option.value)}
              textValue={option.label}
            >
              <span className="flex min-w-0 items-center gap-2">
                <FontAwesomeIcon
                  aria-hidden
                  icon={option.icon}
                  className="size-3.5 shrink-0 text-muted"
                />
                <span className="truncate">{option.label}</span>
              </span>
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
      {description ? <Description>{description}</Description> : null}
    </Select>
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
    <CellSwitch
      aria-label={label}
      className="h-full w-full"
      isSelected={selected}
      onChange={onChange}
      {...(disabled ? { isDisabled: true } : {})}
    >
      <CellSwitch.Trigger className="h-full min-h-14 items-center border-0 bg-transparent px-2 py-2.5 shadow-none data-[hovered=true]:bg-default">
        <span className="flex min-w-0 flex-1 flex-col gap-0.5 text-start">
          <span className="text-sm font-medium text-foreground">{label}</span>
          <span className="text-xs leading-5 text-muted">{description}</span>
        </span>
        <CellSwitch.Control className="ml-auto shrink-0" />
      </CellSwitch.Trigger>
    </CellSwitch>
  );
}
