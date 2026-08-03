// components/privateroutes/PrivateRoute.jsx

import React from "react";
import { Route, Navigate, useLocation } from "react-router-dom";
import { loginPathFor } from "../../../authRedirect";

const PrivateRoute = ({ element: Component, ...rest }) => {
  const token = localStorage.getItem('token');
  const location = useLocation();

  // Check if the token exists (you can customize this logic based on your authentication mechanism)
  const isAuthenticated = !!token;

  // The blocked page rides along on the login URL so the user is returned to it
  // once they sign in.
  return isAuthenticated ? <Component {...rest} /> : <Navigate to={loginPathFor(location)} replace />;
};

export default PrivateRoute;
