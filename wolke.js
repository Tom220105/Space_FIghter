// Anbindung an Supabase fuer die Webfassung: Konto, Bestenliste und
// Spielstand. Gegenstueck zu wolke.py - dieselben Tabellen, dieselbe
// Funktion punkte_melden, dasselbe Konto.
//
// Alles laeuft ueber fetch und meldet sich ueber hole() zurueck, damit das
// Spiel nie auf das Netz wartet. Ohne Netz laeuft das Spiel unveraendert
// weiter, es fehlen dann nur die Bestenlisten.

export const URL = "https://aeujjeagxcmyhmcpewez.supabase.co";
export const ANON = "sb_publishable_P2xqiP1R-81hvtUKJlcQtQ_geSCrm6q";

const KONTO_KEY = "doodlejump.konto.v1";

export class Wolke {
  constructor(url = URL, anon = ANON) {
    // Im Dashboard steht die Adresse mit REST-Anhang - den haengt dieses
    // Modul selbst an, hier also abschneiden.
    this.url = url.replace(/\/+$/, "").replace(/\/(rest|auth)\/v1$/, "");
    this.anon = anon;
    this.token = null;
    this.erneuern = null;
    this.benutzer = null;
    this.name = null;
    this.antworten = [];
    this.laden();
  }

  get angemeldet() { return this.token !== null; }

  get eingerichtet() {
    return !this.url.includes("DEINPROJEKT") && !!this.anon
        && !this.anon.startsWith("DEIN");
  }

  // ------------------------------------------------------------- Auftraege

  registrieren(email, passwort, name) {
    this.lauf("registrieren", async () => {
      const a = await this.anfrage("/auth/v1/signup", "POST",
                                   { email, password: passwort }, false);
      if (!a.access_token) return { bestaetigen: true };
      this.sitzungMerken(a);
      // Das Konto steht jetzt. Geht nur der Name nicht durch (schon vergeben
      // oder unerlaubte Zeichen), bleibt die Anmeldung bestehen und das
      // Spiel fragt den Namen noch einmal ab.
      try {
        await this.anfrage("/rest/v1/profil", "POST",
                           { id: this.benutzer, name },
                           true, { Prefer: "return=minimal" });
      } catch (e) {
        return { name: null, fehler: String(e.message || e) };
      }
      this.name = name;
      this.speichern();
      return { name };
    });
  }

  anmelden(email, passwort) {
    this.lauf("anmelden", async () => {
      const a = await this.anfrage("/auth/v1/token?grant_type=password", "POST",
                                   { email, password: passwort }, false);
      this.sitzungMerken(a);
      const treffer = await this.anfrage(
        `/rest/v1/profil?id=eq.${this.benutzer}&select=name`);
      this.name = treffer && treffer.length ? treffer[0].name : null;
      this.speichern();
      return { name: this.name };
    });
  }

  // Anzeigenamen nachtragen - fuer Konten, bei denen das Anlegen des
  // Profils schiefging (Name schon vergeben oder unerlaubte Zeichen).
  nameSetzen(name) {
    this.lauf("name", async () => {
      await this.anfrage("/rest/v1/profil", "POST",
                         { id: this.benutzer, name },
                         true, { Prefer: "resolution=merge-duplicates,return=minimal" });
      this.name = name;
      this.speichern();
      return { name };
    });
  }

  abmelden() {
    this.token = this.erneuern = this.benutzer = this.name = null;
    try { localStorage.removeItem(KONTO_KEY); } catch (e) {}
  }

  punkteMelden(modus, punkte, dauer) {
    this.lauf("punkte", async () => {
      await this.anfrage("/rest/v1/rpc/punkte_melden", "POST",
                         { p_modus: modus, p_punkte: Math.round(punkte),
                           p_dauer: Math.round(dauer) });
      return { punkte: Math.round(punkte) };
    });
  }

  bestenliste(modus, anzahl = 100) {
    this.lauf("bestenliste", async () => {
      const zeilen = await this.anfrage(
        `/rest/v1/bestenliste?modus=eq.${encodeURIComponent(modus)}`
        + `&select=platz,name,punkte,gemeldet&order=platz.asc&limit=${anzahl | 0}`);
      return { modus, zeilen: zeilen || [] };
    });
  }

  meinPlatz(modus) {
    this.lauf("platz", async () => {
      const platz = await this.anfrage("/rest/v1/rpc/mein_platz", "POST",
                                       { p_modus: modus });
      return { modus, platz };
    });
  }

  standHoch(daten) {
    this.lauf("stand_hoch", async () => {
      await this.anfrage("/rest/v1/spielstand", "POST",
                         { spieler: this.benutzer, stand: daten,
                           geaendert: "now()" },
                         true, { Prefer: "resolution=merge-duplicates,return=minimal" });
      return { gespeichert: true };
    });
  }

  standRunter() {
    this.lauf("stand_runter", async () => {
      const treffer = await this.anfrage(
        `/rest/v1/spielstand?spieler=eq.${this.benutzer}&select=stand`);
      return { stand: treffer && treffer.length ? treffer[0].stand : null };
    });
  }

  // Fertige Antworten abholen: [Art, geklappt, Daten]
  hole() {
    const fertig = this.antworten;
    this.antworten = [];
    return fertig;
  }

  // ------------------------------------------------------------ Innenleben

  async lauf(art, fn) {
    if (!this.eingerichtet) {
      this.antworten.push([art, false, "Supabase ist nicht eingetragen"]);
      return;
    }
    try {
      this.antworten.push([art, true, await fn()]);
    } catch (e) {
      this.antworten.push([art, false, String(e.message || e)]);
    }
  }

  async anfrage(pfad, methode = "GET", daten = null, mitToken = true,
                zusatz = null, zweiterVersuch = false) {
    const kopf = { apikey: this.anon, "Content-Type": "application/json" };
    if (mitToken && this.token) kopf.Authorization = "Bearer " + this.token;
    if (zusatz) Object.assign(kopf, zusatz);
    const antwort = await fetch(this.url + pfad, {
      method: methode, headers: kopf,
      body: daten === null ? undefined : JSON.stringify(daten),
    });
    if (antwort.status === 401 && this.erneuern && !zweiterVersuch) {
      await this.tokenErneuern();          // abgelaufen: einmal erneuern
      return this.anfrage(pfad, methode, daten, mitToken, zusatz, true);
    }
    const text = await antwort.text();
    if (!antwort.ok) {
      let meldung = `Fehler ${antwort.status}`;
      try {
        const j = JSON.parse(text);
        meldung = j.message || j.msg || j.error_description || j.error || meldung;
      } catch (e) {}
      throw new Error(meldung);
    }
    return text.trim() ? JSON.parse(text) : null;
  }

  async tokenErneuern() {
    const a = await this.anfrage("/auth/v1/token?grant_type=refresh_token",
                                 "POST", { refresh_token: this.erneuern },
                                 false, null, true);
    this.sitzungMerken(a);
  }

  sitzungMerken(a) {
    this.token = a.access_token;
    this.erneuern = a.refresh_token || null;
    this.benutzer = (a.user || {}).id || null;
    this.speichern();
  }

  speichern() {
    try {
      localStorage.setItem(KONTO_KEY, JSON.stringify({
        token: this.token, erneuern: this.erneuern,
        benutzer: this.benutzer, name: this.name,
      }));
    } catch (e) {}
  }

  laden() {
    try {
      const d = JSON.parse(localStorage.getItem(KONTO_KEY) || "{}");
      this.token = d.token || null;
      this.erneuern = d.erneuern || null;
      this.benutzer = d.benutzer || null;
      this.name = d.name || null;
    } catch (e) {}
  }
}
