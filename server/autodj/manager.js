// Gestion des stations AutoDJ : un moteur (encodeur + mélangeur) par station.
import { EventEmitter } from 'node:events';
import { AutoDJ } from './engine.js';
import { getStation, listStations } from './stations.js';
import { fail } from './library.js';

export class AutoDJManager extends EventEmitter {
  constructor({ getIcecast, api, log }) {
    super();
    Object.assign(this, { getIcecast, api, log });
    this.players = new Map(); // id de station -> AutoDJ
  }

  /** Moteur de la station (créé à la demande). */
  player(id) {
    id = Number(id);
    let p = this.players.get(id);
    if (!p) {
      if (!getStation(id)) throw fail('Station introuvable', 404);
      p = new AutoDJ({ stationId: id, getStation: () => getStation(id), getIcecast: this.getIcecast, api: this.api, log: this.log });
      p.on('change', () => this.emit('change'));
      this.players.set(id, p);
    }
    return p;
  }

  status() {
    return { stations: listStations().map((s) => this.player(s.id).status()) };
  }

  /** Démarre les stations qui étaient en marche (au lancement du dashboard). */
  async startEnabled() {
    for (const s of listStations()) if (s.enabled) await this.player(s.id).start();
  }

  /** Arrête et oublie le moteur d'une station supprimée. */
  async remove(id) {
    const p = this.players.get(Number(id));
    if (!p) return;
    await p.stop();
    p.removeAllListeners();
    this.players.delete(Number(id));
    this.emit('change');
  }

  /** Les playlists ou la bibliothèque ont changé : chaque station oublie ses titres préparés. */
  resetAll() {
    for (const p of this.players.values()) p.resetUpcoming();
  }

  /** Relance l'encodeur d'une station en marche (après un changement de flux de sortie). */
  async restart(id) {
    const p = this.player(id);
    if (!p.encoder) return;
    await p.stop();
    await p.start();
  }
}
