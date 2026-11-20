import { Component, ReactNode } from 'react';

/** Affiche un message au lieu d'une page blanche si un écran plante au rendu. */
export default class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="card narrow">
        <h1>Cette page n'a pas pu s'afficher</h1>
        <div className="alert alert-danger">{this.state.error.message}</div>
        <p className="muted small">Rechargez la page. Si le problème persiste, transmettez ce message à l'administrateur.</p>
        <div className="actions">
          <button className="btn btn-primary" onClick={() => window.location.reload()}>Recharger</button>
          <a className="btn" href="#/">Tableau de bord</a>
        </div>
      </div>
    );
  }
}
