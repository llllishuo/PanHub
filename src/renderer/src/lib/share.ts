/**
 * 分享链接解析的渲染层封装
 *
 * 解析在渲染层做还是主进程做？
 * → 解析是纯函数、无副作用，放在渲染层可以边输入边解析（防抖），
 *   不用每次按键都过一趟 IPC。
 */
import { useEffect, useRef, useState } from 'react';
import { parseShareLink, ShareParseError, type ShareParseResult } from '../../../core/share.ts';

interface ParseState {
  result: ShareParseResult | null;
  error: string;
  parsing: boolean;
}

/** 输入防抖 + 增量解析 */
export function useDeferredParse(text: string, delay = 220): ParseState {
  const [state, setState] = useState<ParseState>({ result: null, error: '', parsing: false });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    const trimmed = text.trim();
    if (!trimmed) {
      setState({ result: null, error: '', parsing: false });
      return;
    }
    setState((s) => ({ ...s, parsing: true }));
    timer.current = setTimeout(() => {
      try {
        setState({ result: parseShareLink(trimmed), error: '', parsing: false });
      } catch (e) {
        setState({
          result: null,
          error: e instanceof ShareParseError ? e.message : String(e),
          parsing: false,
        });
      }
    }, delay);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [text, delay]);

  return state;
}
