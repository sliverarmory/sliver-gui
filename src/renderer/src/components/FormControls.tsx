import type { IconDefinition } from "@fortawesome/fontawesome-svg-core";
import {
  Description,
  FieldError,
  Input,
  Label,
  ListBox,
  Select,
  TextArea,
  TextField,
} from "@heroui/react";
import { CellSwitch } from "@heroui-pro/react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faChevronDown } from "@fortawesome/free-solid-svg-icons";
import type { ReactNode } from "react";

interface FieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  description?: string;
  error?: string | undefined;
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
  error,
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
      isInvalid={Boolean(error)}
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
      {error ? <FieldError>{error}</FieldError> : null}
    </TextField>
  );
}

interface AreaFieldProps extends Omit<FieldProps, "type" | "min" | "max"> {
  rows?: number;
  action?: ReactNode;
}

export function AreaField({
  label,
  value,
  onChange,
  description,
  error,
  placeholder,
  rows = 4,
  required,
  mono,
  name,
  action,
}: AreaFieldProps) {
  return (
    <TextField
      fullWidth
      variant="secondary"
      name={name ?? label.toLowerCase().replaceAll(" ", "-")}
      isInvalid={Boolean(error)}
      value={value}
      onChange={onChange}
      {...(required ? { isRequired: true } : {})}
    >
      <div className="flex items-center justify-between gap-3">
        <Label>{label}</Label>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      <TextArea
        {...(mono ? { className: "font-mono text-xs" } : {})}
        {...(placeholder ? { placeholder } : {})}
        rows={rows}
      />
      {description ? <Description>{description}</Description> : null}
      {error ? <FieldError>{error}</FieldError> : null}
    </TextField>
  );
}

export interface SelectFieldOption<Value extends string = string> {
  value: Value;
  label: string;
  icon: IconDefinition;
}

interface SelectFieldProps<Value extends string> {
  label: string;
  value: Value;
  onChange: (value: Value) => void;
  options: readonly SelectFieldOption<Value>[];
  description?: string;
  disabled?: boolean;
  error?: string | undefined;
}

const EMPTY_SELECT_KEY = "__sliver_empty_option__";

function optionKey(value: string): string {
  return value === "" ? EMPTY_SELECT_KEY : value;
}

export function selectFieldValueFromKey<Value extends string>(
  options: readonly Pick<SelectFieldOption<Value>, "value">[],
  key: unknown,
): Value | undefined {
  if (typeof key !== "string" && typeof key !== "number") return undefined;
  const normalizedKey = String(key);
  return options.find((option) => optionKey(option.value) === normalizedKey)?.value;
}

export function SelectField<Value extends string>({
  label,
  value,
  onChange,
  options,
  description,
  disabled,
  error,
}: SelectFieldProps<Value>) {
  const selectedOption = options.find((option) => option.value === value);

  return (
    <Select
      fullWidth
      variant="secondary"
      value={optionKey(value)}
      isInvalid={Boolean(error)}
      {...(disabled ? { isDisabled: true } : {})}
      onChange={(nextValue) => {
        const selectedValue = selectFieldValueFromKey(options, nextValue);
        if (selectedValue !== undefined) onChange(selectedValue);
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
      {error ? <FieldError>{error}</FieldError> : null}
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
