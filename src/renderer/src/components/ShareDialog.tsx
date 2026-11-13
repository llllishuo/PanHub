import { useEffect, useState } from 'react';
import type { ShareParseResult } from '../../../core/share.ts';
import { useDeferredParse } from '../lib/share.ts';
import { driverLabel } from '../types.ts';

interface Props {
  onClose: () => void;
  onUse: (r: ShareParseResult) => void;
}

export default function ShareDialog({ onClose, onUse }: Props) {
  const [text, setText] = useState('');
  const { result, error, parsing } = useDeferredParse(text);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const supported = result?.supported ?? false;

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="dialog narrow" onMouseDown={(e) => e.stopPropagation()}>
        <header className="dialog-head">
          <div>
            <h2>从分享链接添加</h2>
            <p className="sub">
              粘贴分享链接，自动识别网盘并填入分享码与提取码。
              也可以直接粘贴「复制这段内容…提取码:xxxx」的整段文字。
            </p>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </header>

        <div className="form">
          <label className="field">
            <span className="field-label">分享链接</span>
            <textarea
              autoFocus
              rows={4}
              value={text}
              placeholder="https://www.alipan.com/s/xxxx  或  https://pan.baidu.com/s/1xxxx?pwd=1111"
              onChange={(e) => setText(e.target.value)}
              spellCheck={false}
            />
          </label>

          {parsing && <p className="muted tiny">识别中…</p>}

          {error && <div className="badge-line error">{error}</div>}

          {result && (
            <div className="share-result">
              <div className="share-row">
                <span className="share-key">网盘</span>
                <span className="share-val">
                  {result.providerLabel}
                  <code>{result.provider}</code>
                </span>
              </div>
              <div className="share-row">
                <span className="share-key">分享 ID</span>
                <span className="share-val mono">{result.shareId}</span>
              </div>
              {result.password && (
                <div className="share-row">
                  <span className="share-key">提取码</span>
                  <span className="share-val mono">{result.password}</span>
                </div>
              )}

              <div className={`badge-line ${supported ? 'ok' : 'warn'}`}>
                {supported ? (
                  <>
                    可解析 · 将使用引擎驱动 <code>{result.driver}</code>
                    {result.missing.length > 0 && (
                      <> ；还需要你补充：<b>{result.missing.join('、')}</b></>
                    )}
                  </>
                ) : (
                  <>暂不支持直接解析</>
                )}
              </div>

              {result.note && <p className="share-note">{result.note}</p>}
            </div>
          )}
        </div>

        <footer className="dialog-foot">
          <span className="muted tiny">
            {result && supported
              ? `驱动「${driverLabel(result.driver ?? '').label}」`
              : '支持 13 类常见网盘链接识别'}
          </span>
          <div className="spacer" />
          <button className="btn ghost" onClick={onClose}>
            取消
          </button>
          <button
            className="btn primary"
            disabled={!supported}
            onClick={() => result && onUse(result)}
          >
            填入并添加
          </button>
        </footer>
      </div>
    </div>
  );
}
