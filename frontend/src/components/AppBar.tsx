import { Link, useNavigate } from "react-router";

import { useAuth } from "../auth/AuthContext";
import { SearchBox } from "./SearchBox";
import { Button } from "./ui/Button";
import { Wordmark } from "./Wordmark";

export function AppBar() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  return (
    // flex-wrap is load-bearing, not decoration: logged in, this row asks
    // for 571px (wordmark + search + u/username + three ghost buttons).
    // On a 390px phone that overflowed the viewport by 181px, which makes
    // the WHOLE page wider than the screen — every block below it, the
    // item board included, then lays out against a viewport the screen
    // cannot show, and the board reads as lopsided even though its columns
    // are exactly equal. Nothing is dropped; the nav drops to a second row.
    <header className="mx-auto flex w-full max-w-5xl flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 py-3">
      <Link to="/" aria-label="OPTATA home">
        <Wordmark size="sm" />
      </Link>
      <SearchBox className="hidden sm:block" />
      <Button
        variant="ghost"
        onClick={() => navigate("/search")}
        className="h-9 px-3 text-sm sm:hidden"
      >
        Search
      </Button>
      {user ? (
        // usernames run to 20 chars, so this group alone can want ~410px —
        // it has to be allowed to wrap inside itself, not just as a unit
        <div className="flex flex-wrap items-center justify-end gap-0.5">
          <Link
            to={`/u/${user.username}`}
            // Hidden on phones, where it is the single widest thing in the
            // bar (up to ~180px for a 20-char username) and also the most
            // redundant: the wordmark points at "/", which already
            // redirects a signed-in visitor to this exact page.
            className="hidden px-2 font-mono text-sm lowercase tracking-tight underline-offset-4 hover:underline sm:inline"
          >
            u/{user.username}
          </Link>
          <Button
            variant="ghost"
            onClick={() => navigate("/reservations")}
            className="h-9 px-2.5 text-sm"
          >
            My dibs
          </Button>
          <Button
            variant="ghost"
            onClick={() => navigate("/settings")}
            className="h-9 px-2.5 text-sm"
          >
            Settings
          </Button>
          <Button variant="ghost" onClick={() => void logout()} className="h-9 px-2.5 text-sm">
            Log out
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={() => navigate("/login")} className="h-9 px-3 text-sm">
            Log in
          </Button>
          <Button
            variant="primary"
            onClick={() => navigate("/register")}
            className="h-9 px-3 text-sm"
          >
            Start yours
          </Button>
        </div>
      )}
    </header>
  );
}
