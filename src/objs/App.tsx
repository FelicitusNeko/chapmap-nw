import React from 'react';
import '../css/App.css';

import ModSquareSym from './modules/SquareSym';

const App: React.FC = () => {
  return (
    <div className="App">
      <hgroup>
        <header>ChapMap</header>
      </hgroup>
      Module: <select>
        <option>Squarewave Symphony</option>
      </select>
      <br />
      <ModSquareSym />
    </div>
  );
}

export default App;
