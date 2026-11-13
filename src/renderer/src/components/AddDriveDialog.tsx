import { useEffect, useMemo, useRef, useState } from 'react';
import type { DriverCatalog, DriverDef, DriverField } from '../types.ts';
import { driverLabel } from '../types.ts';
import { bridge, humanError } from '../lib/bridge.ts';
import { toast, toastError } from './Toast.tsx';

/** 从分享链接解析结果预填 */
export interface DrivePrefill {
  driver: string;
  values: Record<string, string>;
}

interface Props {
  catalog: DriverCatalog;
  onClose: () => void;
  onAdded: () => void;
  /** 预填（例如来自分享链接解析） */
  initial?: DrivePrefill;
}

/** 敏感字段：默认遮起来，可切换显示 */
const SECRET_HINTS = ['cookie', 'token', 'secret', 'password', 'key', 'pass'];

function isSecretField(name: string): boolean {
  const n = name.toLowerCase();
  return SECRET_HINTS.some((h) => n.includes(h));
}

function FieldInput({
  field,
  value,
  onChange,
}: {
  field: DriverField;
  value: string;
  onChange: (v: string) => void;
}) {
  const [reveal, setReveal] = useState(false);

  if (field.type === 'bool') {
    const on = value === 'true';
    return (
      <button
        type="button"
        className={`switch ${on ? 'on' : ''}`}
        onClick={() => onChange(on ? 'false' : 'true')}
        aria-pressed={on}
      >
        <span className="knob" />
        <span className="switch-label">{on ? '开启' : '关闭'}</span>
      </button>
    );
  }

  if (field.type === 'select') {
    const opts = field.options.split(',').map((s) => s.trim()).filter(Boolean);
    return (
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {opts.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    );
  }

  if (field.type === 'text') {
    return (
      <textarea
        rows={3}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
      />
    );
  }

  const secret = isSecretField(field.name);
  return (
    <div className="input-wrap">
      <input
        type={secret && !reveal ? 'password' : 'text'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        autoComplete="off"
        placeholder={field.default || (field.required ? '必填' : '可选')}
      />
      {secret && (
        <button type="button" className="reveal" onClick={() => setReveal((v) => !v)}>
          {reveal ? '隐藏' : '显示'}
        </button>
      )}
    </div>
  );
}

export default function AddDriveDialog({ catalog, onClose, onAdded, initial }: Props) {
  const seed = useRef<DrivePrefill | undefined>(initial);
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<string | null>(initial?.driver ?? null);
  const [mountPath, setMountPath] = useState('');
  const [remark, setRemark] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);

  // 按中文名/驱动名过滤
  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return Object.entries(catalog)
      .map(([name, def]) => ({ name, def, ...driverLabel(name) }))
      .filter(({ name, label }) => !q || name.toLowerCase().includes(q) || label.includes(q))
      .sort((a, b) => {
        // 常见网盘优先
        const ca = catalog[a.name]?.common ? 1 : 0;
        const cb = catalog[b.name]?.common ? 1 : 0;
        if (ca !== cb) return cb - ca;
        return a.name.localeCompare(b.name);
      });
  }, [catalog, query]);

  const def: DriverDef | null = picked ? (catalog[picked] ?? null) : null;

  // 选中驱动后初始化表单默认值（分享预填的字段优先）
  useEffect(() => {
    if (!picked || !def) return;
    const init: Record<string, string> = {};
    for (const f of def.additional) init[f.name] = f.default ?? '';
    const seeded = seed.current && seed.current.driver === picked ? seed.current.values : {};
    setValues({ ...init, ...seeded });
    setMountPath((p) => p || `/${picked.replace(/[^\w]+/g, '-').toLowerCase()}`);
    setAdvanced(false);
  }, [picked, def]);

  const requiredFields = def ? def.additional.filter((f) => f.required) : [];
  const optionalFields = def ? def.additional.filter((f) => !f.required) : [];

  const missing = requiredFields.filter((f) => !values[f.name]?.trim()).map((f) => f.name);

  async function submit() {
    if (!picked || !def) return;
    if (!mountPath.startsWith('/')) {
      toast('挂载路径必须以 / 开头', 'warn');
      return;
    }
    if (missing.length > 0) {
      toast(`还有必填项未填：${missing.join('、')}`, 'warn');
      return;
    }
    setBusy(true);
    try {
      const addition: Record<string, string> = {};
      for (const [k, v] of Object.entries(values)) {
        if (v !== '') addition[k] = v;
      }
      await bridge.addMount({ mountPath, driver: picked, addition, remark });
      toast(`已添加「${driverLabel(picked).label}」`, 'success');
      onAdded();
      onClose();
    } catch (e) {
      toastError(humanError(e));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="dialog" onMouseDown={(e) => e.stopPropagation()}>
        <header className="dialog-head">
          <div>
            <h2>{picked ? `连接 ${driverLabel(picked).label}` : '选择网盘类型'}</h2>
            <p className="sub">
              {picked
                ? '填写下方信息即可。凭据会加密保存在本机，下次启动无需重新登录。'
                : `共 ${Object.keys(catalog).length} 种存储后端，按名称搜索`}
            </p>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </header>

        {!picked && (
          <>
            <div className="search-row">
              <input
                autoFocus
                placeholder="搜索网盘，例如 百度 / 夸克 / OneDrive"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <div className="driver-grid">
              {list.map((d) => (
                <button key={d.name} className="driver-card" onClick={() => setPicked(d.name)}>
                  <span className="driver-icon">{d.icon}</span>
                  <span className="driver-name">{d.label}</span>
                  <span className="driver-raw">{d.name}</span>
                </button>
              ))}
              {list.length === 0 && <p className="muted">没有匹配的存储类型</p>}
            </div>
          </>
        )}

        {picked && def && (
          <>
            <button className="back-link" onClick={() => setPicked(null)}>
              ← 换一个类型
            </button>

            {def.alert && <div className="driver-alert">{def.alert.split('|').pop()}</div>}

            <div className="form">
              <label className="field">
                <span className="field-label">
                  挂载路径 <em>必填</em>
                </span>
                <input
                  value={mountPath}
                  onChange={(e) => setMountPath(e.target.value)}
                  spellCheck={false}
                />
                <span className="field-help">在文件列表里显示为这个名字，不能与已有重复</span>
              </label>

              {requiredFields.map((f) => (
                <label className="field" key={f.name}>
                  <span className="field-label">
                    {f.name} <em>必填</em>
                  </span>
                  <FieldInput
                    field={f}
                    value={values[f.name] ?? ''}
                    onChange={(v) => setValues((s) => ({ ...s, [f.name]: v }))}
                  />
                  {f.help && <span className="field-help">{f.help}</span>}
                </label>
              ))}

              {optionalFields.length > 0 && (
                <>
                  <button className="adv-toggle" onClick={() => setAdvanced((v) => !v)}>
                    {advanced ? '▾' : '▸'} 高级选项（{optionalFields.length} 项，通常无需修改）
                  </button>
                  {advanced &&
                    optionalFields.map((f) => (
                      <label className="field" key={f.name}>
                        <span className="field-label">{f.name}</span>
                        <FieldInput
                          field={f}
                          value={values[f.name] ?? ''}
                          onChange={(v) => setValues((s) => ({ ...s, [f.name]: v }))}
                        />
                        {f.help && <span className="field-help">{f.help}</span>}
                      </label>
                    ))}
                </>
              )}

              <label className="field">
                <span className="field-label">备注</span>
                <input value={remark} onChange={(e) => setRemark(e.target.value)} />
              </label>
            </div>

            <footer className="dialog-foot">
              <span className="muted tiny">
                {missing.length > 0 ? `待填：${missing.length} 项` : '可以添加了'}
              </span>
              <div className="spacer" />
              <button className="btn ghost" onClick={onClose}>
                取消
              </button>
              <button className="btn primary" onClick={submit} disabled={busy || missing.length > 0}>
                {busy ? '添加中…' : '添加网盘'}
              </button>
            </footer>
          </>
        )}
      </div>
    </div>
  );
}
