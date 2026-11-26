import { useCallback, useEffect, useState } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';

import { OperatorLogin } from './OperatorLogin';
import { OperatorModulesPage } from './OperatorModulesPage';
import { getOperatorSession, type OperatorProfile } from './operator-api';
import { operatorPaths } from './operator-paths';
import './operator.css';

const OPERATOR_DOCUMENT_TITLE = 'Operatör · Servora-Med';

/**
 * Installation-operator area (MOD-002). Mounted by `App` for `/operator` and
 * `/operator/*` before the customer tree, so the customer identity bootstrap,
 * providers, shell, navigation and realtime never run here.
 */
export function OperatorArea() {
  const [operator, setOperator] = useState<OperatorProfile | null | undefined>(undefined);
  const [notice, setNotice] = useState('');

  useEffect(() => { document.title = OPERATOR_DOCUMENT_TITLE; }, []);

  useEffect(() => {
    let active = true;
    getOperatorSession()
      .then((current) => { if (active) setOperator(current); })
      .catch(() => {
        if (!active) return;
        setNotice('Operatör oturumu doğrulanamadı. Giriş yaparak tekrar deneyin.');
        setOperator(null);
      });
    return () => { active = false; };
  }, []);

  const endSession = useCallback((message: string) => {
    setNotice(message);
    setOperator(null);
  }, []);

  const signedOut = useCallback(() => {
    setNotice('');
    setOperator(null);
  }, []);

  if (operator === undefined) {
    return (
      <main className="identity-loading" aria-live="polite" aria-busy="true">
        <div className="loading-line loading-line-short" />
        <div className="loading-line" />
        <p>Operatör oturumu doğrulanıyor</p>
      </main>
    );
  }

  if (operator === null) {
    return <OperatorLogin initialNotice={notice} onAuthenticated={(next) => { setNotice(''); setOperator(next); }} />;
  }

  return (
    <Routes>
      <Route
        path={operatorPaths.modules}
        element={<OperatorModulesPage operator={operator} onSessionEnded={endSession} onSignedOut={signedOut} />}
      />
      <Route path="*" element={<Navigate to={operatorPaths.modules} replace />} />
    </Routes>
  );
}
