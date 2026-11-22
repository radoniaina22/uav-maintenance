import { useEffect, useState } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import type { Session } from '@supabase/supabase-js';
import { isConfigured, supabase } from './lib/supabase';
import { AppProvider, useApp } from './lib/app';
import Layout from './components/Layout';
import Login from './pages/Login';
import { lazyPage } from './lib/lazyPage';

// Chaque page est un fichier séparé, téléchargé à sa première ouverture (premier affichage plus rapide sur réseau lent)
const Dashboard = lazyPage(() => import('./pages/Dashboard'));
const Flights = lazyPage(() => import('./pages/Flights'));
const FlightForm = lazyPage(() => import('./pages/FlightForm'));
const FlightDetail = lazyPage(() => import('./pages/FlightDetail'));
const Reports = lazyPage(() => import('./pages/Reports'));
const Statistics = lazyPage(() => import('./pages/Statistics'));
const MonthlyReports = lazyPage(() => import('./pages/MonthlyReports'));
const Alerts = lazyPage(() => import('./pages/Alerts'));
const Planning = lazyPage(() => import('./pages/Planning'));
const Drones = lazyPage(() => import('./pages/Drones'));
const DroneDetail = lazyPage(() => import('./pages/DroneDetail'));
const Batteries = lazyPage(() => import('./pages/Batteries'));
const Parts = lazyPage(() => import('./pages/Parts'));
const PartDetail = lazyPage(() => import('./pages/PartDetail'));
const PartLabels = lazyPage(() => import('./pages/PartLabels'));
const Scan = lazyPage(() => import('./pages/Scan'));
const Consumption = lazyPage(() => import('./pages/Consumption'));
const FlightCrm = lazyPage(() => import('./pages/FlightCrm'));
const CrmExport = lazyPage(() => import('./pages/CrmExport'));
const WorkOrders = lazyPage(() => import('./pages/WorkOrders'));
const WorkOrderDetail = lazyPage(() => import('./pages/WorkOrderDetail'));
const AuditLog = lazyPage(() => import('./pages/AuditLog'));
const Ranking = lazyPage(() => import('./pages/Ranking'));
const DroneHistory = lazyPage(() => import('./pages/DroneHistory'));
const BatteryDetail = lazyPage(() => import('./pages/BatteryDetail'));
const Pilots = lazyPage(() => import('./pages/Pilots'));
const Facilities = lazyPage(() => import('./pages/Facilities'));
const Logbook = lazyPage(() => import('./pages/Logbook'));
const DronePorts = lazyPage(() => import('./pages/DronePorts'));
const Users = lazyPage(() => import('./pages/Users'));

function AdminOnly({ children }: { children: JSX.Element }) {
  const { isAdmin } = useApp();
  return isAdmin ? children : <Navigate to="/" replace />;
}

export default function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  if (!isConfigured) {
    return (
      <div className="center-screen">
        <div className="card narrow">
          <h1>Configuration manquante</h1>
          <p>Définissez <code>VITE_SUPABASE_URL</code> et <code>VITE_SUPABASE_ANON_KEY</code> dans le fichier <code>.env</code> (voir <code>.env.example</code>), puis relancez l'application.</p>
        </div>
      </div>
    );
  }

  if (session === undefined) return <div className="center-screen muted">Chargement…</div>;
  if (!session) return <Login />;

  return (
    <AppProvider key={session.user.id} session={session}>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Dashboard />} />
          <Route path="vols" element={<Flights />} />
          <Route path="vols/nouveau" element={<FlightForm />} />
          <Route path="vols/:id" element={<FlightDetail />} />
          <Route path="vols/:id/modifier" element={<FlightForm />} />
          <Route path="vols/:id/crm" element={<FlightCrm />} />
          <Route path="crm/export" element={<CrmExport />} />
          <Route path="ordres-travail" element={<WorkOrders />} />
          <Route path="ordres-travail/:id" element={<WorkOrderDetail />} />
          <Route path="audit" element={<AdminOnly><AuditLog /></AdminOnly>} />
          <Route path="carnet" element={<Logbook />} />
          <Route path="carnet/:pilotId" element={<Logbook />} />
          <Route path="statistiques" element={<Statistics />} />
          <Route path="rapports-mensuels" element={<MonthlyReports />} />
          <Route path="classement" element={<Ranking />} />
          <Route path="consommation" element={<Consumption />} />
          <Route path="planification" element={<Planning />} />
          <Route path="rapports" element={<Reports />} />
          <Route path="alertes" element={<Alerts />} />
          <Route path="drones" element={<Drones />} />
          <Route path="drones/:id" element={<DroneDetail />} />
          <Route path="drones/:id/historique" element={<DroneHistory />} />
          <Route path="pieces" element={<Parts />} />
          <Route path="pieces/etiquettes" element={<PartLabels />} />
          <Route path="scan" element={<Scan />} />
          <Route path="pieces/:id" element={<PartDetail />} />
          <Route path="batteries" element={<Batteries />} />
          <Route path="batteries/:id" element={<BatteryDetail />} />
          <Route path="pilotes" element={<Pilots />} />
          <Route path="csb" element={<Facilities />} />
          <Route path="drone-ports" element={<AdminOnly><DronePorts /></AdminOnly>} />
          <Route path="utilisateurs" element={<AdminOnly><Users /></AdminOnly>} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </AppProvider>
  );
}
