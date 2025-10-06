import { useState, useEffect } from 'react';
import io from 'socket.io-client';
import './App.css';

const socket = io();

function App() {
  const [amount, setAmount] = useState('');
  const [company, setCompany] = useState('united-india');

  const handleSubmit = (e) => {
    e.preventDefault();
    // Always send company to the server; server will decide how to handle Reliance vs United India
    if (amount) {
      socket.emit('autofill', { amount, company });
      setAmount('');
    }
  };

  return (
    <div className="App">
      <header className="App-header">
        <h1>Selenium Form Filler</h1>
        <form onSubmit={handleSubmit}>
          <label htmlFor="company-select">Select company:</label>
          <select
            id="company-select"
            value={company}
            onChange={(e) => setCompany(e.target.value)}
            style={{ marginLeft: 8, marginRight: 16 }}
          >
            <option value="united-india">United India</option>
            <option value="reliance">Reliance</option>
          </select>

          <input
            type="number"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="Enter amount"
          />
          <button type="submit">Autofill Form</button>
        </form>
      </header>
    </div>
  ); 
}

export default App;