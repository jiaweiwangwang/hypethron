import React from 'react';
import {BrowserRouter as Router, Route} from 'react-router-dom';
import {Provider} from 'react-redux';

import HypethronIntroPage from "../pages/HypethronIntroPage/HypethronIntroPage.js";
import HomePage from "../pages/HomePage/HomePage.js";

import AxiosDemo from "../components/AxiosDemo/AxiosDemo.js";
import ReduxDemo from "../components/ReduxDemo/ReduxDemo.js";

import {store} from "../redux/HypethronRedux.js";

class HypethronRouter extends React.Component {
  // 在此注册页面级别的内容
  // 注意：除根目录外，所有React页面需要暴露在 /pages 路径下
  render() {
    return (
      <Provider store={store}>
        <Router>
          <Route exact path="/" component={HypethronIntroPage}/>
          <Route path="/pages/home" component={HomePage}/>

          <Route path="/pages/AxiosDemo" component={AxiosDemo}/>
          <Route path="/pages/ReduxDemo" component={ReduxDemo}/>
        </Router>
      </Provider>
    )
  }
}


export default HypethronRouter;