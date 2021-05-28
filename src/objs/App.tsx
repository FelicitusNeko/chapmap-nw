import React from 'react';
import '../css/App.css';

//import ModSquareSym from './modules/SquareSym';
import ModSqSyNewsByte from './modules/SqSyNewsByte';

const App: React.FC = () => {
  return (
    <div className="App">
      <hgroup>
        <header>ChapMap</header>
      </hgroup>
      Module: <select defaultValue="SqSyNewsByte">
        <option value="SquareSym">Squarewave Symphony</option>
        <option value="SqSyNewsByte">Squarewave Symphony NewsByte</option>
      </select>
      <br />
      <ModSqSyNewsByte />
    </div>
  );
}

export default App;
