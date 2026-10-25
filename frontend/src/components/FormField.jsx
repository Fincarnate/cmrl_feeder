export default function FormField({ label, id, error, ...inputProps }) {
    return <div className="form-field">
        <label htmlFor={id}>{label}</label>
        <input id={id} required aria-invalid={Boolean(error)} aria-describedby={error ? `${id}-error` : undefined} {...inputProps} />
        {error && <span className="field-error" id={`${id}-error`}>{error}</span>}
    </div>;
}
