import { useEffect, useId, useRef, useState } from 'react'
import { Button, TitleButton } from '../components/retro'
import { getUnits, makeFormat, setUnits, type Units } from '../lib/units'

interface Choice<K extends keyof Units> {
  key: K
  legend: string
  options: { value: Units[K]; label: string }[]
}

const CHOICES = [
  { key: 'temp', legend: 'Temperature', options: [{ value: 'c', label: 'Celsius (°C)' }, { value: 'f', label: 'Fahrenheit (°F)' }] },
  { key: 'speed', legend: 'Wind speed', options: [{ value: 'kmh', label: 'Kilometres per hour (km/h)' }, { value: 'mph', label: 'Miles per hour (mph)' }] },
  { key: 'clock', legend: 'Clock', options: [{ value: '24', label: '24-hour (13:15)' }, { value: '12', label: '12-hour (1:15 pm)' }] },
] as [Choice<'temp'>, Choice<'speed'>, Choice<'clock'>]

/**
 * Units dialog, NT "Properties" style: changes apply on OK, Cancel or Escape leaves them as
 * they were. A native <dialog> keeps focus inside while it is open.
 */
export function UnitsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const [draft, setDraft] = useState<Units>(getUnits)

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) {
      const units = getUnits()
      setDraft(units)
      dialog.showModal()
      // Start on the current temperature choice, the first thing people change (not on Close).
      dialog.querySelector<HTMLInputElement>(`input[name="temp"][value="${units.temp}"]`)?.focus()
    } else if (!open && dialog.open) {
      dialog.close()
    }
  }, [open])

  const sample = makeFormat(draft)

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      className="r-window r-dialog"
      onClose={onClose}
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
    >
      <div className="r-title">
        <h2 id={titleId} className="m-0 min-w-0 flex-1 truncate text-[inherit] font-bold">
          Units
        </h2>
        <TitleButton glyph="close" label="Close" onClick={onClose} />
      </div>
      <form
        method="dialog"
        className="flex flex-col gap-3 p-3"
        onSubmit={(event) => {
          event.preventDefault()
          setUnits(draft)
          onClose()
        }}
      >
        {CHOICES.map((choice) => (
          <fieldset key={choice.key} className="r-fieldset">
            <legend>{choice.legend}</legend>
            {choice.options.map((o) => (
              <label key={o.value} className="flex cursor-pointer items-center gap-2 py-0.5">
                <input
                  type="radio"
                  className="r-radio"
                  name={choice.key}
                  value={o.value}
                  checked={draft[choice.key] === o.value}
                  onChange={() => setDraft((d) => ({ ...d, [choice.key]: o.value }))}
                />
                {o.label}
              </label>
            ))}
          </fieldset>
        ))}
        <p className="r-status-field m-0 tabular-nums" style={{ whiteSpace: 'normal', height: 'auto' }}>
          Example: {sample.t(21)}, wind {sample.s(12)}, sunset {sample.time('17:45')}
        </p>
        <p className="m-0 max-w-[42ch] text-[0.92em] text-[var(--text-muted)]">
          Rain stays in millimetres. Model test scores on the Models and Analytics pages stay in °C, km/h and mm, as
          they were measured.
        </p>
        <div className="flex justify-end gap-1.5">
          <Button type="submit" className="min-w-[75px]">
            OK
          </Button>
          <Button onClick={onClose} className="min-w-[75px]">
            Cancel
          </Button>
        </div>
      </form>
    </dialog>
  )
}
