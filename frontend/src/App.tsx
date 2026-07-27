import { BrowserRouter, Route, Routes } from "react-router";

import { useAuth, AuthProvider } from "./auth/AuthContext";
import { ServerWakingBanner } from "./components/ServerWakingBanner";
import { Tag } from "./components/ui/Tag";
import { ToastProvider } from "./components/ui/Toast";
import { Wordmark } from "./components/Wordmark";
import ForgotPassword from "./routes/ForgotPassword";
import Landing from "./routes/Landing";
import Login from "./routes/Login";
import NotFound from "./routes/NotFound";
import Profile from "./routes/Profile";
import Register from "./routes/Register";
import Reservations from "./routes/Reservations";
import ResetPassword from "./routes/ResetPassword";
import Search from "./routes/Search";
import Settings from "./routes/Settings";

function BootSplash() {
  return (
    <main className="grid min-h-dvh place-items-center px-4">
      <Tag className="px-10 pb-8 pt-2 motion-safe:animate-pulse">
        <Wordmark />
      </Tag>
    </main>
  );
}

function AppRoutes() {
  const { booting } = useAuth();
  // The mount-time refresh hasn't settled: showing routes now would flash
  // logged-out UI at a logged-in user.
  if (booting) return <BootSplash />;

  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />
      <Route path="/forgot-password" element={<ForgotPassword />} />
      <Route path="/reset-password" element={<ResetPassword />} />
      <Route path="/u/:username" element={<Profile />} />
      <Route path="/settings" element={<Settings />} />
      <Route path="/reservations" element={<Reservations />} />
      <Route path="/search" element={<Search />} />
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <ToastProvider>
        <BrowserRouter>
          <AppRoutes />
        </BrowserRouter>
        <ServerWakingBanner />
      </ToastProvider>
    </AuthProvider>
  );
}
